"""
Export a BS-RoFormer checkpoint (ZFTurbo's Music-Source-Separation-Training format) to ONNX with
the STFT outside the graph, matching the interface of src/separation/roformer.ts:

  input  mix_spec   [1, 4, 1025, frames]  planes: left re, left im, right re, right im
  output stems_spec [1, 4, 1025, frames]  the target stem's spectrogram, same layout

Usage (needs torch, einops, beartype, rotary_embedding_torch, pyyaml and a clone of
https://github.com/ZFTurbo/Music-Source-Separation-Training):
  python tools/export/bs_roformer_onnx.py <msst repo> <config.yaml> <model.ckpt> <out.onnx> [frames]
"""
import sys

import torch
import yaml
from torch import nn


def main():
    repo, cfg_path, ckpt_path, out_path = sys.argv[1:5]
    sys.path.insert(0, repo)
    from models.bs_roformer.bs_roformer import BSRoformer

    class Loader(yaml.SafeLoader):
        pass

    Loader.add_constructor('tag:yaml.org,2002:python/tuple', lambda l, n: tuple(l.construct_sequence(n)))
    cfg = yaml.load(open(cfg_path), Loader=Loader)
    mcfg = dict(cfg['model'])
    mcfg['use_torch_checkpoint'] = False
    mcfg['flash_attn'] = True  # scaled_dot_product_attention exports as MatMul/Softmax, not Einsum
    model = BSRoformer(**mcfg)
    state = torch.load(ckpt_path, map_location='cpu', weights_only=False)
    state = state.get('state_dict', state) if isinstance(state, dict) else state
    model.load_state_dict(state)
    model.eval()
    hop = cfg['model'].get('stft_hop_length', 512)
    frames = int(sys.argv[5]) if len(sys.argv) > 5 else cfg['audio']['chunk_size'] // hop + 1

    class Wrap(nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, mix_spec):
            m = self.m
            _, _, nf, nt = mix_spec.shape
            # [1, (s c), f, t] -> [1, (f s), t, c]
            spec = mix_spec.reshape(1, 2, 2, nf, nt).permute(0, 3, 1, 4, 2).reshape(1, nf * 2, nt, 2)
            x = spec.permute(0, 2, 1, 3).reshape(1, nt, nf * 4)
            x = m.band_split(x)
            for block in m.layers:
                time_t, freq_t = block[-2], block[-1]
                b, t, f, d = x.shape
                x = x.permute(0, 2, 1, 3).reshape(b * f, t, d)
                x = time_t(x)
                x = x.reshape(b, f, t, d).permute(0, 2, 1, 3).reshape(b * t, f, d)
                x = freq_t(x)
                x = x.reshape(b, t, f, d)
            x = m.final_norm(x)
            mask = m.mask_estimators[0](x)  # [1, t, (f s c)]
            mask = mask.reshape(1, nt, nf * 2, 2).permute(0, 2, 1, 3)  # [1, (f s), t, c]
            sr, si = spec[..., 0], spec[..., 1]
            mr, mi = mask[..., 0], mask[..., 1]
            out = torch.stack([sr * mr - si * mi, sr * mi + si * mr], dim=-1)  # [1, (f s), t, c]
            out = out.reshape(1, nf, 2, nt, 2).permute(0, 2, 4, 1, 3).reshape(1, 4, nf, nt)
            if m.zero_dc:
                out = torch.cat([torch.zeros_like(out[:, :, :1]), out[:, :, 1:]], dim=2)
            return out

    w = Wrap(model).eval()
    dummy = torch.randn(1, 4, 1025, frames) * 0.1
    with torch.no_grad():
        # Reference check against the model's own forward (STFT inside) on random audio.
        audio = torch.randn(1, 2, (frames - 1) * hop) * 0.1
        ref = model(audio)
        win = torch.hann_window(2048)
        st = torch.stft(audio.reshape(2, -1), 2048, hop, 2048, win, return_complex=True)
        ms = torch.stack([st[0].real, st[0].imag, st[1].real, st[1].imag])[None]
        o = w(ms)[0]
        rec = torch.stack([torch.istft(torch.complex(o[2 * c], o[2 * c + 1]), 2048, hop, 2048, win, length=audio.shape[-1]) for c in range(2)])
        print('wrapper vs model max abs diff', (rec - ref.reshape(2, -1)).abs().max().item(), 'ref max', ref.abs().max().item())
        torch.onnx.export(w, (dummy,), out_path, input_names=['mix_spec'], output_names=['stems_spec'], opset_version=17, dynamo=False)
    print('exported', out_path, 'frames', frames)


if __name__ == '__main__':
    main()
