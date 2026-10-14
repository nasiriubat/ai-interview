import fitz, zipfile, json, os
base = "/Users/mhnash/Desktop/projects/ai-interview/.claude/worktrees/agent-a0d17a8667c5ce565/marketing/demo-2026-10/screenshots"
for src, folder, prefix, pages in [("report.pdf", "case1-discovery", "23-report-pdf-page", [0, 2, 6]), ("spec.pdf", "case2-requirements", "15-specification-pdf-page", [0, 3])]:
    d = fitz.open("/private/tmp/claude-504/d/" + src)
    print(src, "pages", d.page_count)
    for i, n in enumerate(pages):
        if n < d.page_count:
            d[n].get_pixmap(matrix=fitz.Matrix(2, 2)).save(f"{base}/{folder}/{prefix}-{i+1}.png")
z = zipfile.ZipFile("/private/tmp/claude-504/d/bundle.zip")
print("\n".join(f"{i.filename} {i.file_size}" for i in z.infolist()))
diff = json.load(open("/private/tmp/claude-504/d/diff.json"))
print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in diff.items()})[:600])
if isinstance(diff.get("requirements"), dict):
    print({k: len(v) for k, v in diff["requirements"].items()})
