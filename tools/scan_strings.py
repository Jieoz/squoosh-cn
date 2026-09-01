import re, sys, json
path = sys.argv[1]
s = open(path, encoding="utf-8", errors="replace").read()
cands = set()
for m in re.finditer(r'"((?:[^"\\]|\\.){2,70})"', s):
    v = m.group(1)
    if not re.search(r"[A-Za-z]", v):
        continue
    if re.search(r"[\u4e00-\u9fff]", v):
        continue
    if not (re.match(r"^[A-Z][A-Za-z]", v) or " " in v):
        continue
    if re.search(r"[<>{}();=/\\#$@|]", v):
        continue
    if re.search(r"_[a-z0-9]{5,}", v):
        continue
    if re.search(r"\.(js|wasm|png|jpg|svg)$", v):
        continue
    if re.match(r"^[a-z]+[A-Z]", v):
        continue
    cands.add(v)
for v in sorted(cands, key=lambda x: (-len(x), x)):
    print(json.dumps(v, ensure_ascii=False))
print("TOTAL", len(cands), file=sys.stderr)
