"""
Make an exported ONNX graph run on onnxruntime-web's WebGPU provider: replace every Split with
more than 4 outputs by one Slice per output (WebGPU shaders may bind at most 10 storage
buffers), and optionally convert weights to fp16 with float32 inputs/outputs.

Usage: python tools/export/webgpu_friendly.py <in.onnx> <out.onnx> [--fp16]
"""
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper


def split_to_slices(model):
    g = model.graph
    consts = {i.name: numpy_helper.to_array(i) for i in g.initializer}
    for n in g.node:
        if n.op_type == 'Constant':
            consts[n.output[0]] = numpy_helper.to_array(n.attribute[0].t)
    new_nodes = []
    added = []
    for n in g.node:
        if n.op_type != 'Split' or len(n.output) <= 4:
            new_nodes.append(n)
            continue
        axis = next((a.i for a in n.attribute if a.name == 'axis'), 0)
        if len(n.input) > 1 and n.input[1]:
            sizes = consts[n.input[1]].tolist()
        else:
            sizes = list(next(a.ints for a in n.attribute if a.name == 'split'))
        start = 0
        for k, (out, size) in enumerate(zip(n.output, sizes)):
            base = f'{n.name or "split"}_slice{k}'
            for nm, val in (('s', start), ('e', start + size), ('a', axis)):
                t = numpy_helper.from_array(np.array([val], dtype=np.int64), f'{base}_{nm}')
                added.append(t)
            new_nodes.append(helper.make_node('Slice', [n.input[0], f'{base}_s', f'{base}_e', f'{base}_a'], [out], name=base))
            start += size
    del g.node[:]
    g.node.extend(new_nodes)
    g.initializer.extend(added)
    return model


def main():
    src, dst = sys.argv[1:3]
    model = onnx.load(src)
    model = split_to_slices(model)
    if '--fp16' in sys.argv:
        from onnxconverter_common import float16
        model = float16.convert_float_to_float16(model, keep_io_types=True)
        # The converter retypes Cast outputs as float16 but leaves Cast(to=float) nodes inside the
        # graph casting to float32; make those cast to float16 too (graph inputs/outputs keep
        # their float32 casts, which the converter added itself).
        typed16 = {v.name for v in model.graph.value_info if v.type.tensor_type.elem_type == onnx.TensorProto.FLOAT16}
        for n in model.graph.node:
            if n.op_type == 'Cast' and n.output[0] in typed16:
                for a in n.attribute:
                    if a.name == 'to' and a.i == onnx.TensorProto.FLOAT:
                        a.i = onnx.TensorProto.FLOAT16
    onnx.save(model, dst)
    print('saved', dst)


if __name__ == '__main__':
    main()
