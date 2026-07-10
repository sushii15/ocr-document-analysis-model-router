import json
import os
import sys
import tempfile
from pathlib import Path


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: paddle_ocr_bridge.py <pdf-or-image-path> [max_pages]")
    source = Path(sys.argv[1])
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else int(os.environ.get("PADDLE_OCR_MAX_PAGES", "1"))
    image_paths = render_input(source, max_pages)
    result = run_ocr(image_paths)
    print(json.dumps(result, ensure_ascii=False))


def render_input(source: Path, max_pages: int):
    suffix = source.suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}:
        return [str(source)]

    import fitz

    temp_dir = Path(tempfile.mkdtemp(prefix="docrouter-paddle-"))
    doc = fitz.open(str(source))
    pages = min(len(doc), max_pages)
    paths = []
    for index in range(pages):
        page = doc.load_page(index)
        pix = page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6), alpha=False)
        out = temp_dir / f"page-{index + 1}.png"
        pix.save(str(out))
        paths.append(str(out))
    return paths


def run_ocr(image_paths):
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    from paddleocr import PaddleOCR

    ocr = PaddleOCR(
        lang="en",
        device="cpu",
        enable_mkldnn=False,
        text_detection_model_name=os.environ.get("PADDLE_OCR_DET_MODEL", "PP-OCRv6_tiny_det"),
        text_recognition_model_name=os.environ.get("PADDLE_OCR_REC_MODEL", "PP-OCRv6_tiny_rec"),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )

    pages = []
    all_text = []
    for page_index, image_path in enumerate(image_paths, start=1):
        predictions = ocr.predict(image_path)
        page_lines = []
        for prediction in predictions:
            data = dict(prediction)
            texts = data.get("rec_texts") or []
            scores = data.get("rec_scores") or []
            boxes = data.get("rec_boxes")
            if boxes is None:
                boxes = data.get("dt_polys")
            if boxes is None:
                boxes = []
            for idx, text in enumerate(texts):
                clean = str(text).strip()
                if not clean:
                    continue
                score = float(scores[idx]) if idx < len(scores) else None
                box = normalize_box(boxes[idx]) if idx < len(boxes) else None
                page_lines.append({"text": clean, "confidence": score, "box": box})
                all_text.append(clean)
        page_lines = sorted(page_lines, key=lambda row: ((row.get("box") or {}).get("y0", 0), (row.get("box") or {}).get("x0", 0)))
        pages.append({
            "page": page_index,
            "line_count": len(page_lines),
            "average_confidence": average([line["confidence"] for line in page_lines if line.get("confidence") is not None]),
            "lines": page_lines,
            "table_rows": infer_table_rows(page_lines),
        })
    return {
        "engine": "paddleocr",
        "text": "\n".join(all_text),
        "average_confidence": average([line["confidence"] for page in pages for line in page["lines"] if line.get("confidence") is not None]),
        "pages": pages,
        "table_row_count": sum(len(page["table_rows"]) for page in pages),
        "line_count": sum(page["line_count"] for page in pages),
    }


def normalize_box(box):
    try:
        arr = box.tolist() if hasattr(box, "tolist") else box
        if len(arr) == 4 and all(isinstance(value, (int, float)) for value in arr):
            x0, y0, x1, y1 = arr
            return {"x0": float(x0), "y0": float(y0), "x1": float(x1), "y1": float(y1)}
        xs = [float(point[0]) for point in arr]
        ys = [float(point[1]) for point in arr]
        return {"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)}
    except Exception:
        return None


def infer_table_rows(lines):
    rows = []
    bucketed = {}
    for line in lines:
        box = line.get("box") or {}
        y = box.get("y0")
        if y is None:
            continue
        key = round(y / 12) * 12
        bucketed.setdefault(key, []).append(line)
    for _key, group in sorted(bucketed.items()):
        group = sorted(group, key=lambda line: (line.get("box") or {}).get("x0", 0))
        text_parts = [line["text"] for line in group]
        numeric_count = sum(1 for part in text_parts if any(ch.isdigit() for ch in part))
        if len(group) >= 3 and numeric_count >= 2:
            rows.append({
                "text": " | ".join(text_parts),
                "cell_count": len(group),
                "average_confidence": average([line["confidence"] for line in group if line.get("confidence") is not None]),
                "cells": [{"text": line["text"], "confidence": line.get("confidence"), "box": line.get("box")} for line in group],
            })
    return rows


def average(values):
    values = [value for value in values if value is not None]
    return round(sum(values) / len(values), 4) if values else None


if __name__ == "__main__":
    main()
