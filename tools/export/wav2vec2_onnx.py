"""
Export a Hugging Face wav2vec2 CTC model to ONNX (input_values [1, samples] -> logits
[1, frames, vocab]) plus an fp16 copy, and save its vocab.json next to it.

Usage: python tools/export/wav2vec2_onnx.py <hf model id> <out dir>
"""
import json
import os
import sys

import torch
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor


def main():
    model_id, out = sys.argv[1:3]
    os.makedirs(out, exist_ok=True)
    model = Wav2Vec2ForCTC.from_pretrained(model_id, attn_implementation='eager').eval()
    proc = Wav2Vec2Processor.from_pretrained(model_id)
    json.dump(proc.tokenizer.get_vocab(), open(f'{out}/vocab.json', 'w'))
    dummy = torch.randn(1, 16000 * 4)
    with torch.no_grad():
        torch.onnx.export(model, (dummy,), f'{out}/model.onnx', input_names=['input_values'], output_names=['logits'],
                          dynamic_axes={'input_values': {1: 'samples'}, 'logits': {1: 'frames'}}, opset_version=17, dynamo=False)
    print('exported', out)


if __name__ == '__main__':
    main()
