"""Run one image through the pipeline and print every stage record. Usage: python -m eval.debug_one IMG"""
import json
import sys

from eval.run_eval import run_one

r = run_one(sys.argv[1])
for k, v in r["stages"].items():
    print(k, json.dumps(v, ensure_ascii=False)[:600])
print("TEXT:", (r["text"] or "")[:500])
print(r["error"])
