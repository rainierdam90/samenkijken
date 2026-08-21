"""Build responsive SameCouch hero assets without changing the artwork."""

from pathlib import Path
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "samecouch-hero-source.png"
SIZES = (480, 768, 1024)


def main() -> None:
    with Image.open(SOURCE) as original:
        image = original.convert("RGB")
        for width in SIZES:
            resized = image if image.width == width else image.resize(
                (width, round(image.height * width / image.width)),
                Image.Resampling.LANCZOS,
            )
            stem = ROOT / "public" / f"samecouch-hero-{width}"
            resized.save(stem.with_suffix(".webp"), "WEBP", quality=78, method=6)
            resized.save(stem.with_suffix(".avif"), "AVIF", quality=52, speed=6)


if __name__ == "__main__":
    main()
