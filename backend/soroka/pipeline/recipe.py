"""Per-page recipe (§5.3.4): output = original + this JSON. Each editable stage has a value and a
`manual` flag; automatic re-runs never overwrite manual values."""
import copy

STAGES = ["quality", "acceptance", "crop", "orientation", "dewarp", "deskew", "cleanup", "ocr", "layout",
          "consistency", "outputs"]
EDITABLE = ["acceptance", "crop", "orientation", "dewarp", "deskew", "cleanup", "ocr"]

DEFAULT = {
    "acceptance": {"value": None, "manual": False},       # document | uncertain | non_document
    "crop": {"quad": None, "method": None, "manual": False},  # 4 points TL,TR,BR,BL in original px
    "orientation": {"angle": 0, "manual": False},          # clockwise degrees: 0/90/180/270
    "dewarp": {"enabled": False, "method": None, "mesh": None, "manual": False},
    "deskew": {"angle": 0.0, "manual": False},             # degrees, positive = counter-clockwise
    "cleanup": {"mode": None, "strength": 1.0, "manual": False},  # color | gray | bw
    "ocr": {"langs": "rus+eng", "manual": False},
}


def default_recipe() -> dict:
    return copy.deepcopy(DEFAULT)


def normalize(data: dict | None) -> dict:
    out = default_recipe()
    for k, v in (data or {}).items():
        if k in out and isinstance(v, dict):
            out[k].update(v)
    return out


def stage_index(stage: str) -> int:
    return STAGES.index(stage) if stage in STAGES else 0


def apply_edit(recipe: dict, stage: str, value: dict | None, reset: bool = False) -> dict:
    """Return a new recipe with a user edit. reset=True returns the stage to automatic."""
    r = normalize(recipe)
    if stage not in EDITABLE:
        raise ValueError("stage_not_editable")
    if reset:
        r[stage] = copy.deepcopy(DEFAULT[stage])
        return r
    v = dict(value or {})
    if stage == "orientation":
        v["angle"] = int(v.get("angle", 0)) % 360
        if v["angle"] not in (0, 90, 180, 270):
            raise ValueError("bad_angle")
    if stage == "deskew":
        v["angle"] = max(-15.0, min(15.0, float(v.get("angle", 0))))
    if stage == "cleanup":
        if v.get("mode") not in ("color", "gray", "bw"):
            raise ValueError("bad_mode")
        v["strength"] = max(0.0, min(1.0, float(v.get("strength", 1.0))))
    if stage == "crop":
        q = v.get("quad")
        if not (isinstance(q, list) and len(q) == 4 and all(len(p) == 2 for p in q)):
            raise ValueError("bad_quad")
        v["quad"] = [[float(x), float(y)] for x, y in q]
        v["method"] = "manual"
    if stage == "ocr":
        langs = "+".join(x for x in str(v.get("langs", "rus+eng")).split("+") if x in ("rus", "eng"))
        v["langs"] = langs or "rus+eng"
    if stage == "acceptance" and v.get("value") not in ("document", "non_document"):
        raise ValueError("bad_value")
    r[stage].update(v)
    r[stage]["manual"] = True
    return r
