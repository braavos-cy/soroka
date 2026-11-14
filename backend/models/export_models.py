"""Export the page models to ONNX (run in the Docker build's `models` stage; the app only needs onnxruntime).

- MobileSAM (Apache-2.0, github.com/ChaoningZhang/MobileSAM): finds the page as a mask from points on its text.
  Two files: the image encoder (1x3x1024x1024 normalized, padded image -> embeddings) and the prompt decoder
  (embeddings + 5 points -> 3 candidate masks at 256x256 + their predicted quality).
- SyntheticDoc (MIT, github.com/tanguymagne/SyntheticDoc, ECCV 2026): flattens a photographed page and estimates
  its shading. Input RGB normalized to [-1, 1] ((x - 0.5) / 0.5); outputs the backward map (2 x gh x gw in [-1, 1],
  grid_sample convention, align_corners=True; channel 0 = x) and the shading map (3 x H x W in [-1, 1]).
  low:  input 1x3x720x512,   map 31 x 45
  high: input 1x3x1440x1024, map 121 x 177

Usage: python export_models.py OUT_DIR  (with MobileSAM and SyntheticDoc checked out under /src)
"""
import sys

import torch

sys.path.insert(0, "/src/SyntheticDoc/training")
from mobile_sam import sam_model_registry  # noqa: E402
from model import UVDocNet  # noqa: E402  (SyntheticDoc's network)

N_POINTS = 5
out = sys.argv[1]


class Decoder(torch.nn.Module):
    def __init__(self, sam):
        super().__init__()
        self.sam = sam

    def forward(self, embeddings, coords, labels):
        sparse, dense = self.sam.prompt_encoder(points=(coords, labels), boxes=None, masks=None)
        low, iou = self.sam.mask_decoder(image_embeddings=embeddings, image_pe=self.sam.prompt_encoder.get_dense_pe(),
                                         sparse_prompt_embeddings=sparse, dense_prompt_embeddings=dense,
                                         multimask_output=True)
        return low, iou


class Flatten(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        o = self.m(x)
        return o["bm_map"], o["shadow_map"]


def syntheticdoc(path: str):
    ck = torch.load(path, map_location="cpu", weights_only=False)  # checksum-verified checkpoint (Dockerfile)
    hp = ck["hyper_parameters"]
    size = tuple(hp["data"]["image_size"])
    net = UVDocNet(num_filter=hp["model"]["num_filter"], kernel_size=hp["model"]["kernel_size"],
                   bm_out_size=tuple(hp["data"]["bm_out_size"]), output_size=size)
    sd = {k.replace("model.", "", 1): v for k, v in ck["state_dict"].items()}
    net.load_state_dict(sd)
    return Flatten(net.eval()), size


with torch.no_grad():
    _load = torch.load
    torch.load = lambda *a, **k: _load(*a, **{**k, "map_location": "cpu"})  # MobileSAM weights were saved on a GPU
    sam = sam_model_registry["vit_t"](checkpoint="/src/MobileSAM/weights/mobile_sam.pt").eval()
    torch.load = _load
    torch.onnx.export(sam.image_encoder, torch.zeros(1, 3, 1024, 1024), f"{out}/sam_encoder.onnx",
                      input_names=["image"], output_names=["embeddings"], opset_version=17, dynamo=False)
    torch.onnx.export(Decoder(sam), (torch.zeros(1, 256, 64, 64), torch.zeros(1, N_POINTS, 2),
                                     torch.ones(1, N_POINTS)),
                      f"{out}/sam_decoder.onnx", input_names=["embeddings", "coords", "labels"],
                      output_names=["masks", "scores"], opset_version=17, dynamo=False)
    for name in ("low", "high"):
        net, (h, w) = syntheticdoc(f"/src/SyntheticDoc/training/model/{name}.ckpt")
        torch.onnx.export(net, torch.zeros(1, 3, h, w), f"{out}/flatten_{name}.onnx", input_names=["image"],
                          output_names=["grid", "shading"], opset_version=17, dynamo=False)
print("exported to", out)
