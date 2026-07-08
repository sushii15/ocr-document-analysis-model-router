from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets" / "social-preview.png"
W, H = 1280, 640


def font(size: int, bold: bool = False):
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (W, H), (247, 247, 246))
    draw = ImageDraw.Draw(img)
    black = (24, 24, 23)
    muted = (92, 92, 88)
    line = (218, 218, 214)

    draw.rectangle((40, 40, W - 40, H - 40), outline=line, width=2)
    draw.text((80, 78), "Model Router", fill=black, font=font(72, True))
    draw.text((84, 162), "for OCR document analysis, invoices, bank statements, and long PDFs", fill=muted, font=font(29))

    pills = ["BYOK", "non-LLM OCR first", "cost/latency/quality routing", "deterministic eval", "Supabase learning layer"]
    x, y = 84, 250
    for pill in pills:
        text_w = int(draw.textlength(pill, font=font(23, True)))
        draw.rounded_rectangle((x, y, x + text_w + 34, y + 46), radius=23, outline=black, width=2, fill=(252, 252, 251))
        draw.text((x + 17, y + 11), pill, fill=black, font=font(23, True))
        x += text_w + 52
        if x > 980:
            x, y = 84, y + 66

    card_x, card_y = 805, 345
    draw.rounded_rectangle((card_x, card_y, 1160, 520), radius=10, outline=black, width=2, fill=(252, 252, 251))
    draw.text((card_x + 24, card_y + 24), "Recommended model", fill=muted, font=font(21, True))
    draw.text((card_x + 24, card_y + 60), "GPT-4o Mini", fill=black, font=font(38, True))
    draw.text((card_x + 24, card_y + 113), "$0.0018  |  81% quality  |  91% latency", fill=muted, font=font(22))

    draw.line((84, 538, 1160, 538), fill=line, width=2)
    draw.text((84, 558), "Route documents to the cheapest model that can still extract them correctly.", fill=black, font=font(26, True))
    img.save(OUT)
    print(OUT)


if __name__ == "__main__":
    main()
