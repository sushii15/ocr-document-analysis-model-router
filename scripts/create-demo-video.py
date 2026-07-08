from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
FRAME_DIR = ROOT / "docs" / "assets" / "demo" / "frames"
OUT = ROOT / "docs" / "assets" / "docrouter-demo.mp4"
FPS = 24
SIZE = (1280, 720)


def load_frame(name: str) -> np.ndarray:
    image = cv2.imread(str(FRAME_DIR / name))
    if image is None:
        raise FileNotFoundError(FRAME_DIR / name)
    return cv2.resize(image, SIZE, interpolation=cv2.INTER_AREA)


def ease(t: float) -> float:
    return 1 - (1 - t) ** 3


def put_label(frame: np.ndarray, title: str, subtitle: str) -> None:
    overlay = frame.copy()
    x, y, w, h = 34, 34, 560, 104
    cv2.rectangle(overlay, (x, y), (x + w, y + h), (248, 248, 248), -1)
    cv2.rectangle(overlay, (x, y), (x + w, y + h), (30, 30, 30), 1)
    cv2.addWeighted(overlay, 0.92, frame, 0.08, 0, frame)
    cv2.putText(frame, title, (x + 20, y + 38), cv2.FONT_HERSHEY_SIMPLEX, 0.74, (18, 18, 18), 2, cv2.LINE_AA)
    cv2.putText(frame, subtitle, (x + 20, y + 72), cv2.FONT_HERSHEY_SIMPLEX, 0.43, (90, 90, 90), 1, cv2.LINE_AA)


def draw_cursor(frame: np.ndarray, x: int, y: int) -> None:
    points = np.array([[x, y], [x, y + 32], [x + 9, y + 24], [x + 16, y + 40], [x + 23, y + 37], [x + 16, y + 22], [x + 29, y + 22]])
    cv2.fillPoly(frame, [points + 2], (235, 235, 235))
    cv2.fillPoly(frame, [points], (18, 18, 18))
    cv2.polylines(frame, [points], True, (250, 250, 250), 1, cv2.LINE_AA)


def segment(writer, image, seconds, title, subtitle, cursor_from, cursor_to):
    total = int(seconds * FPS)
    for i in range(total):
        t = ease(i / max(1, total - 1))
        frame = image.copy()
        put_label(frame, title, subtitle)
        x = int(cursor_from[0] + (cursor_to[0] - cursor_from[0]) * t)
        y = int(cursor_from[1] + (cursor_to[1] - cursor_from[1]) * t)
        draw_cursor(frame, x, y)
        writer.write(frame)


def fade(writer, a, b, seconds):
    total = int(seconds * FPS)
    for i in range(total):
        alpha = i / max(1, total - 1)
        frame = cv2.addWeighted(a, 1 - alpha, b, alpha, 0)
        writer.write(frame)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames = [
        load_frame("frame-01-top.png"),
        load_frame("frame-02-router-output.png"),
        load_frame("frame-03-learning.png"),
    ]
    writer = cv2.VideoWriter(str(OUT), cv2.VideoWriter_fourcc(*"mp4v"), FPS, SIZE)
    if not writer.isOpened():
      raise RuntimeError("Could not open MP4 writer")

    segment(writer, frames[0], 4.0, "OCR Document Analysis Model Router", "Upload OCR documents, choose default extraction fields, and route by policy.", (1120, 110), (700, 330))
    fade(writer, frames[0], frames[1], 0.5)
    segment(writer, frames[1], 4.5, "Model ranking", "The router ranks the user's enabled models by quality, latency, and estimated cost.", (660, 230), (1080, 235))
    fade(writer, frames[1], frames[2], 0.5)
    segment(writer, frames[2], 4.5, "Readable extracted output", "Fields and transaction rows are shown first; raw JSON stays available for debugging.", (1060, 250), (880, 440))
    segment(writer, frames[2], 3.5, "Deterministic evaluation", "Rule checks validate structure, reconciliation, and feedback for the learning layer.", (910, 565), (1120, 600))

    writer.release()
    print(OUT)


if __name__ == "__main__":
    main()
