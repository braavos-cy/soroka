"""Per-page recipe (§5.3.4): output = original + this JSON. Each editable stage has a value and a
`manual` flag; automatic re-runs never overwrite manual values."""
import copy

# dewarp (flattening) runs right after the crop: rotation, deskew and OCR work on the flattened page
STAGES = ["quality", "acceptance", "crop", "dewarp", "orientation", "deskew", "cleanup", "ocr", "layout",
          "consistency", "outputs"]
EDITABLE = ["acceptance", "crop", "orientation", "dewarp", "deskew", "cleanup", "ocr"]

DEFAULT = {
    "acceptance": {"value": None, "manual": False},       # document | uncertain | non_document
    # mode "mask": page outline `polygon` (MobileSAM, editable), outside blacked out, cropped to its box;
    # mode "quad": 4 corners TL,TR,BR,BL straightened by perspective; mode "none": the whole photo.
    # Points in original px; switching mode keeps the other mode's points.
    "crop": {"quad": None, "polygon": None, "mode": None, "method": None, "manual": False},
    "orientation": {"angle": 0, "manual": False},          # clockwise degrees: 0/90/180/270
    # SyntheticDoc: model None (no flattening) | "low" | "high"; shading: divide out the page's lighting.
    # mesh: rows x cols control points (x, y in 0..1 of the cropped page) that map onto a flat grid: the model's
    # proposal (for the editor) or, with mesh_edited, a hand-edited mesh used instead of the model's map.
    "dewarp": {"model": None, "shading": False, "mesh": None, "mesh_edited": False, "manual": False},
    "deskew": {"angle": 0.0, "manual": False},             # degrees, positive = counter-clockwise
    "cleanup": {"mode": None, "strength": 1.0, "manual": False},  # color | gray | bw
    "ocr": {"langs": "rus+eng", "manual": False},
}


def default_recipe() -> dict:
    return copy.deepcopy(DEFAULT)


FLATTEN_MODELS = (None, "low", "high")


def normalize(data: dict | None) -> dict:
    out = default_recipe()
    for k, v in (data or {}).items():
        if k in out and isinstance(v, dict):
            out[k].update(v)
    d = out["dewarp"]
    if "enabled" in d:  # recipes from the UVDoc version: on -> high-res model; a hand-edited mesh stays in use
        on = bool(d.pop("enabled"))
        d.pop("method", None)
        d["model"] = "high" if on else None
        d["shading"] = on
        d["mesh_edited"] = bool(on and d.get("manual") and d.get("mesh"))
        if not d["mesh_edited"]:
            d["mesh"] = None
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
        if v.get("mode") == "none":  # no crop: the whole photo (points of the other modes are kept)
            v = {"mode": "none"}
        elif v.get("mode") == "mask" and v.get("polygon") is None:  # back to the stored outline
            if not r["crop"].get("polygon"):
                raise ValueError("no_outline")
            v = {"mode": "mask"}
        elif v.get("mode") == "quad" and v.get("quad") is None:  # back to the stored 4 corners
            if not r["crop"].get("quad"):
                raise ValueError("bad_quad")
            v = {"mode": "quad"}
        elif v.get("polygon") is not None:  # page outline
            pg = v["polygon"]
            if not (isinstance(pg, list) and 4 <= len(pg) <= 400 and all(isinstance(p, list) and len(p) == 2 for p in pg)):
                raise ValueError("bad_polygon")
            v = {"polygon": [[float(x), float(y)] for x, y in pg], "mode": "mask"}
        else:
            q = v.get("quad")
            if not (isinstance(q, list) and len(q) == 4 and all(len(p) == 2 for p in q)):
                raise ValueError("bad_quad")
            v = {"quad": [[float(x), float(y)] for x, y in q], "mode": "quad"}
        v["method"] = "manual"
    if stage == "dewarp":
        cur = r["dewarp"]
        if "enabled" in v and "model" not in v:  # older clients: on / off
            v["model"] = "high" if v["enabled"] else None
        model = v.get("model", cur.get("model"))
        if model not in FLATTEN_MODELS:
            raise ValueError("bad_model")
        out = {"model": model, "shading": bool(v.get("shading", cur.get("shading", False)))}
        mesh = v.get("mesh")
        if "mesh" in v and mesh is None:  # back to the model's map
            out.update({"mesh": None, "mesh_edited": False})
        elif mesh is not None:
            ok = (isinstance(mesh, list) and 2 <= len(mesh) <= 60
                  and all(isinstance(r, list) and len(r) == len(mesh[0]) and 2 <= len(r) <= 60 for r in mesh)
                  and all(isinstance(p, list) and len(p) == 2 and all(-0.5 <= float(c) <= 1.5 for c in p)
                          for r in mesh for p in r))
            if not ok:
                raise ValueError("bad_mesh")
            out.update({"mesh": [[[round(float(x), 5), round(float(y), 5)] for x, y in row] for row in mesh],
                        "mesh_edited": True})
        v = out
    if stage == "ocr":
        langs = "+".join(x for x in str(v.get("langs", "rus+eng")).split("+") if x in ("rus", "eng"))
        v["langs"] = langs or "rus+eng"
    if stage == "acceptance" and v.get("value") not in ("document", "non_document"):
        raise ValueError("bad_value")
    r[stage].update(v)
    r[stage]["manual"] = True
    return r
