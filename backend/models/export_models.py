"""Export the page models to ONNX (run in the Docker build's `models` stage; the app only needs onnxruntime).

- MobileSAM (Apache-2.0, github.com/ChaoningZhang/MobileSAM): finds the page as a mask from points on its text.
  Two files: the image encoder (1x3x1024x1024 normalized, padded image -> embeddings) and the prompt decoder
  (embeddings + 5 points -> 3 candidate masks at 256x256 + their predicted quality).
- UVDoc (MIT, github.com/tanguymagne/UVDoc): flattens a photographed page. Input 1x3x712x488 RGB in [0, 1],
  output the 2D unwarping grid 1x2x45x31 in [-1, 1] (grid_sample convention, align_corners=True).

Usage: python export_models.py OUT_DIR  (with MobileSAM and UVDoc checked out under /src)
"""
import sys

import torch

sys.path.insert(0, "/src/UVDoc")
from mobile_sam import sam_model_registry  # noqa: E402
from utils import load_model  # noqa: E402  (UVDoc)

N_POINTS = 5
out = sys.argv[1]
_load = torch.load
torch.load = lambda *a, **k: _load(*a, **{**k, "map_location": "cpu"})  # weights were saved on a GPU


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


class UV(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        return self.m(x)[0]


with torch.no_grad():
    sam = sam_model_registry["vit_t"](checkpoint="/src/MobileSAM/weights/mobile_sam.pt").eval()
    torch.onnx.export(sam.image_encoder, torch.zeros(1, 3, 1024, 1024), f"{out}/sam_encoder.onnx",
                      input_names=["image"], output_names=["embeddings"], opset_version=17, dynamo=False)
    torch.onnx.export(Decoder(sam), (torch.zeros(1, 256, 64, 64), torch.zeros(1, N_POINTS, 2),
                                     torch.ones(1, N_POINTS)),
                      f"{out}/sam_decoder.onnx", input_names=["embeddings", "coords", "labels"],
                      output_names=["masks", "scores"], opset_version=17, dynamo=False)
    uv = load_model("/src/UVDoc/model/best_model.pkl").eval()
    torch.onnx.export(UV(uv), torch.zeros(1, 3, 712, 488), f"{out}/uvdoc.onnx", input_names=["image"],
                      output_names=["grid"], opset_version=17, dynamo=False)
print("exported to", out)
