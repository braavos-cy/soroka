"""Synthetic, reproducible test set for the image pipeline.

Documents (EN / RU; letter, table, receipt) are rendered as clean pages, then captured as
  scan       – flat page, full frame, light noise, tiny skew
  photo      – page on a textured table, roughly straight, uneven light, shadow, blur, JPEG
  angled     – like photo, plus strong perspective (camera at an angle)
and finally rotated 0/90/180/270 (how the phone was held). Non-documents: procedural photos with zero words
(scenes, table without paper, blank sheet, wall, dark shot, colourful noise).

Ground truth (manifest.json) per image: is_document, lang, fix_rotation (clockwise degrees the pipeline must
apply), quad (page corners TL,TR,BR,BL of the upright page, in the delivered image's pixels), words.

Usage: python -m eval.make_testset OUT_DIR [--seed N]
"""
import argparse
import json
import math
import os
import random

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONTS = "/usr/share/fonts/truetype"
SERIF = [f"{FONTS}/dejavu/DejaVuSerif.ttf", f"{FONTS}/liberation/LiberationSerif-Regular.ttf",
         f"{FONTS}/crosextra/Caladea-Regular.ttf"]
SANS = [f"{FONTS}/dejavu/DejaVuSans.ttf", f"{FONTS}/liberation/LiberationSans-Regular.ttf",
        f"{FONTS}/crosextra/Carlito-Regular.ttf"]
BOLD = [f"{FONTS}/dejavu/DejaVuSans-Bold.ttf", f"{FONTS}/liberation/LiberationSans-Bold.ttf"]
MONO = [f"{FONTS}/dejavu/DejaVuSansMono.ttf", f"{FONTS}/liberation/LiberationMono-Regular.ttf"]

TEXT = {
    "en": {
        "title": ["Lease Agreement", "Notice of Payment", "Medical Certificate", "Letter of Recommendation"],
        "body": [
            "This agreement is made between the landlord and the tenant for the rental of the apartment located "
            "on the second floor of the building. The tenant agrees to pay the monthly rent on the first day of "
            "each month and to keep the premises in good and clean condition.",
            "The deposit will be returned within thirty days after the end of the lease, provided that there is "
            "no damage to the property. Any repairs required because of negligence will be deducted from the deposit.",
            "We kindly remind you that the invoice issued last month remains unpaid. Please transfer the full "
            "amount to the bank account indicated below before the end of the current week to avoid late fees.",
            "The patient was examined at our clinic and found to be in satisfactory health. No restrictions on "
            "physical activity are recommended. This certificate is valid for six months from the date of issue.",
            "I have known the applicant for more than four years and can confirm that she is a responsible, "
            "careful and hard working person. She always completed her tasks on time and helped her colleagues.",
            "Both parties confirm that they have read and understood all the terms and conditions of this "
            "document and sign it voluntarily. Copies are provided to each party and have equal legal force.",
        ],
        "table_head": ["Item", "Quantity", "Price", "Total"],
        "items": ["Office chair", "Printer paper", "Desk lamp", "Water filter", "Bookshelf", "Window cleaning",
                  "Delivery service", "Kitchen table"],
        "receipt": ["SUPERMARKET", "Thank you for shopping", "Bread", "Milk", "Cheese", "Apples", "Coffee",
                    "TOTAL", "Card payment"],
        "sign": "Signature",
    },
    "ru": {
        "title": ["Договор аренды", "Уведомление об оплате", "Медицинская справка", "Рекомендательное письмо"],
        "body": [
            "Настоящий договор заключён между арендодателем и арендатором о найме квартиры, расположенной на "
            "втором этаже жилого дома. Арендатор обязуется вносить ежемесячную плату в первый день каждого месяца "
            "и содержать помещение в чистоте и порядке.",
            "Залог будет возвращён в течение тридцати дней после окончания срока аренды при условии, что "
            "имуществу не причинён ущерб. Расходы на ремонт по вине арендатора удерживаются из суммы залога.",
            "Напоминаем вам, что счёт, выставленный в прошлом месяце, до сих пор не оплачен. Просим перечислить "
            "полную сумму на указанный ниже банковский счёт до конца текущей недели, чтобы избежать штрафа.",
            "Пациент был осмотрен в нашей поликлинике, состояние здоровья удовлетворительное. Ограничений "
            "физической нагрузки не установлено. Справка действительна в течение шести месяцев со дня выдачи.",
            "Я знаю заявителя более четырёх лет и могу подтвердить, что она ответственный, внимательный и "
            "трудолюбивый человек. Она всегда выполняла поручения вовремя и охотно помогала своим коллегам.",
            "Стороны подтверждают, что прочитали и поняли все условия настоящего документа и подписывают его "
            "добровольно. Экземпляры переданы каждой из сторон и имеют одинаковую юридическую силу.",
        ],
        "table_head": ["Наименование", "Количество", "Цена", "Сумма"],
        "items": ["Офисное кресло", "Бумага для принтера", "Настольная лампа", "Фильтр для воды",
                  "Книжный шкаф", "Мытьё окон", "Услуги доставки", "Кухонный стол"],
        "receipt": ["ПРОДУКТОВЫЙ МАГАЗИН", "Спасибо за покупку", "Хлеб", "Молоко", "Сыр", "Яблоки", "Кофе",
                    "ИТОГО", "Оплата картой"],
        "sign": "Подпись",
    },
}


def font(paths, size, rnd):
    return ImageFont.truetype(rnd.choice(paths), size)


def wrap(draw, text, fnt, width):
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=fnt) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def render_page(kind: str, lang: str, rnd: random.Random) -> tuple[np.ndarray, list[str]]:
    """Clean page at ~150 dpi. Returns BGR image and the list of rendered words."""
    T = TEXT[lang]
    words: list[str] = []
    if kind == "receipt":
        W, H = 620, 1500
    else:
        W, H = 1240, 1754
    paper = rnd.randint(238, 255)
    im = Image.new("RGB", (W, H), (paper, paper, max(225, paper - rnd.randint(0, 10))))
    d = ImageDraw.Draw(im)
    ink = (rnd.randint(0, 40),) * 3
    m = 110 if kind != "receipt" else 50
    y = m
    if kind == "receipt":
        f = font(MONO, 30, rnd)
        for i, line in enumerate(T["receipt"]):
            if line in T["receipt"][2:7]:
                line = f"{line:<16}{rnd.randint(1, 9)}.{rnd.randint(10, 99)}"
            if line == T["receipt"][7]:
                line = f"{line:<16}{rnd.randint(20, 60)}.{rnd.randint(10, 99)}"
            d.text((m, y), line, font=f, fill=ink)
            words += line.split()
            y += 60 if i in (1, 6) else 46
            if i in (1, 6):
                d.line((m, y - 14, W - m, y - 14), fill=ink, width=2)
        return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR), words

    ft = font(BOLD, rnd.choice([44, 50, 56]), rnd)
    title = rnd.choice(T["title"])
    d.text((m, y), title, font=ft, fill=ink)
    words += title.split()
    y += 110
    fb = font(SERIF + SANS, rnd.choice([26, 28, 30, 32]), rnd)
    lh = int(fb.size * 1.45)
    paras = T["body"][:]
    rnd.shuffle(paras)
    if kind == "table":
        paras = paras[:2]
    for p in paras:
        for line in wrap(d, p, fb, W - 2 * m):
            if y > H - m - 120:
                break
            d.text((m, y), line, font=fb, fill=ink)
            words += line.split()
            y += lh
        y += lh // 2
    if kind == "table":
        y += 20
        cols = [m, m + 470, m + 690, m + 860, W - m]
        items = rnd.sample(T["items"], 6)
        rows = [T["table_head"]] + [[it, str(rnd.randint(1, 12)), f"{rnd.randint(5, 900)}.00",
                                     f"{rnd.randint(50, 9000)}.00"] for it in items]
        for r in rows:
            d.line((cols[0], y, cols[-1], y), fill=ink, width=2)
            for i, c in enumerate(r):
                d.text((cols[i] + 12, y + 12), c, font=fb, fill=ink)
                words += c.split()
            y += lh + 22
        d.line((cols[0], y, cols[-1], y), fill=ink, width=2)
        top = y - len(rows) * (lh + 22)
        for x in cols:
            d.line((x, top, x, y), fill=ink, width=2)
    if y < H - m - 80:
        d.text((m, H - m - 60), T["sign"] + ": ______________", font=fb, fill=ink)
        words.append(T["sign"] + ":")
    return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR), words


# ---------------------------------------------------------------- backgrounds / non-documents
def noise_field(h, w, scale, rnd):
    """Smooth value noise in [0,1]."""
    g = np.random.default_rng(rnd.randint(0, 1 << 30)).random((max(2, h // scale), max(2, w // scale)))
    return cv2.resize(g.astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC).clip(0, 1)


def table_texture(h, w, rnd):
    kind = rnd.choice(["wood", "dark", "fabric", "stone"])
    base = {"wood": (60, 100, 150), "dark": (40, 40, 45), "fabric": (120, 90, 70), "stone": (150, 150, 145)}[kind]
    base = np.array([c + rnd.randint(-20, 20) for c in base], np.float32)
    n = noise_field(h, w, 40, rnd)[..., None]
    img = base * (0.75 + 0.5 * n)
    if kind == "wood":
        y = np.arange(h, dtype=np.float32)[:, None, None]
        img *= 0.9 + 0.1 * np.sin(y / rnd.uniform(6, 14) + 3 * noise_field(h, w, 120, rnd)[..., None])
    fine = np.random.default_rng(rnd.randint(0, 1 << 30)).normal(0, 6, (h, w, 1)).astype(np.float32)
    return np.clip(img + fine, 0, 255).astype(np.uint8)


def nondoc_scene(kind, h, w, rnd):
    r = np.random.default_rng(rnd.randint(0, 1 << 30))
    if kind == "landscape":
        sky = np.linspace([235, 190, 120], [200, 140, 70], h // 2).astype(np.float32)  # BGR, blue sky
        ground = np.linspace([60, 140, 80], [30, 90, 50], h - h // 2).astype(np.float32)
        img = np.concatenate([sky, ground])[:, None, :].repeat(w, 1)
        img *= (0.85 + 0.3 * noise_field(h, w, 60, rnd))[..., None]
        for _ in range(rnd.randint(3, 8)):  # trees / bushes
            cx, cy = rnd.randint(0, w), rnd.randint(h // 3, h)
            cv2.ellipse(img, (cx, cy), (rnd.randint(40, 200), rnd.randint(60, 260)), 0, 0, 360,
                        (rnd.randint(20, 60), rnd.randint(80, 140), rnd.randint(20, 60)), -1)
    elif kind == "people":
        img = table_texture(h, w, rnd).astype(np.float32) * 0.6 + 80
        for _ in range(rnd.randint(2, 5)):
            cx = rnd.randint(w // 6, 5 * w // 6)
            col = [rnd.randint(30, 220) for _ in range(3)]
            cv2.ellipse(img, (cx, int(h * 0.75)), (rnd.randint(120, 220), int(h * 0.3)), 0, 0, 360, col, -1)
            cv2.circle(img, (cx, int(h * 0.38)), rnd.randint(70, 110), (120, 150, 200), -1)
    elif kind == "table":
        img = table_texture(h, w, rnd).astype(np.float32)
        cv2.circle(img, (rnd.randint(200, w - 200), rnd.randint(200, h - 200)), rnd.randint(80, 150),
                   (230, 230, 235), -1)  # a cup seen from above
    elif kind == "blank_sheet":
        img = table_texture(h, w, rnd).astype(np.float32)
        q = np.array([[w * .2, h * .15], [w * .8, h * .18], [w * .78, h * .85], [w * .22, h * .82]], np.int32)
        cv2.fillConvexPoly(img, q, (240, 242, 245))
    elif kind == "wall":
        c = np.array([rnd.randint(150, 230)] * 3, np.float32) + r.normal(0, 8, 3)
        img = np.ones((h, w, 3), np.float32) * c * (0.85 + 0.25 * noise_field(h, w, 200, rnd))[..., None]
    elif kind == "dark":
        img = np.ones((h, w, 3), np.float32) * 25 * (0.5 + noise_field(h, w, 80, rnd))[..., None]
        cv2.circle(img, (w // 2, h // 3), 60, (200, 220, 240), -1)
    elif kind == "colorful":
        img = np.zeros((h, w, 3), np.float32)
        for c in range(3):
            img[..., c] = 255 * noise_field(h, w, rnd.randint(30, 150), rnd)
    elif kind == "screenshot_ui":  # flat UI with icons, no words
        img = np.full((h, w, 3), 245, np.float32)
        for i in range(12):
            y0 = 80 + i * (h // 13)
            cv2.circle(img, (90, y0 + 40), 40, [rnd.randint(50, 250) for _ in range(3)], -1)
            cv2.rectangle(img, (160, y0 + 20), (160 + rnd.randint(200, w - 260), y0 + 60), (225, 225, 225), -1)
    else:
        raise ValueError(kind)
    img = img + r.normal(0, 4, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


NONDOC_KINDS = ["landscape", "people", "table", "blank_sheet", "wall", "dark", "colorful", "screenshot_ui"]


# ---------------------------------------------------------------- capture simulation
def light_gradient(h, w, rnd, strength):
    x = np.linspace(-1, 1, w)[None, :]
    y = np.linspace(-1, 1, h)[:, None]
    a = rnd.uniform(0, 2 * math.pi)
    g = 1 + strength * (np.cos(a) * x + np.sin(a) * y) / 2
    return g.astype(np.float32)[..., None]


def capture(page: np.ndarray, mode: str, rnd: random.Random) -> tuple[np.ndarray, np.ndarray]:
    """Returns (image, quad of the page in it)."""
    ph, pw = page.shape[:2]
    src = np.array([[0, 0], [pw - 1, 0], [pw - 1, ph - 1], [0, ph - 1]], np.float32)
    if mode == "scan":
        ang = rnd.uniform(-1.2, 1.2)
        M = cv2.getRotationMatrix2D((pw / 2, ph / 2), ang, 1.0)
        img = cv2.warpAffine(page, M, (pw, ph), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        img = np.clip(img.astype(np.float32) + np.random.default_rng(rnd.randint(0, 1 << 30)).normal(0, 3, img.shape),
                      0, 255).astype(np.uint8)
        quad = src.copy()  # the page *is* the frame
        return img, quad
    # photo: 3:4 camera frame
    H, W = (2400, 1800) if ph >= pw else (1800, 2400)
    if ph / pw > 2:  # receipt: narrower page in a normal frame
        H, W = 2400, 1800
    bg = table_texture(H, W, rnd)
    fill = rnd.uniform(0.55, 0.8)
    s = min(W * fill / pw, H * fill / ph)
    cw, ch = pw * s, ph * s
    cx, cy = W / 2 + rnd.uniform(-0.08, 0.08) * W, H / 2 + rnd.uniform(-0.06, 0.06) * H
    ang = math.radians(rnd.uniform(-4, 4))
    base = np.array([[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]])
    rot = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]])
    dst = base @ rot.T + [cx, cy]
    if mode == "angled":  # camera tilt: one side shrinks
        side = rnd.choice(["top", "bottom", "left", "right"])
        k = rnd.uniform(0.12, 0.22)
        if side in ("top", "bottom"):
            i, j = (0, 1) if side == "top" else (3, 2)
            mid = (dst[i] + dst[j]) / 2
            dst[i] += (mid - dst[i]) * k * 2
            dst[j] += (mid - dst[j]) * k * 2
        else:
            i, j = (0, 3) if side == "left" else (1, 2)
            mid = (dst[i] + dst[j]) / 2
            dst[i] += (mid - dst[i]) * k * 2
            dst[j] += (mid - dst[j]) * k * 2
        dst += np.array([[rnd.uniform(-25, 25), rnd.uniform(-25, 25)] for _ in range(4)])
    dst = dst.astype(np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(page, M, (W, H), flags=cv2.INTER_LINEAR)
    mask = cv2.warpPerspective(np.full((ph, pw), 255, np.uint8), M, (W, H), flags=cv2.INTER_LINEAR)
    # soft shadow under the page
    sh = cv2.GaussianBlur(mask, (0, 0), 25).astype(np.float32)[..., None] / 255
    off = np.roll(np.roll(sh, 18, 0), 12, 1)
    img = bg.astype(np.float32) * (1 - 0.45 * off)
    a = mask.astype(np.float32)[..., None] / 255
    img = img * (1 - a) + warped.astype(np.float32) * a
    img *= light_gradient(H, W, rnd, rnd.uniform(0.15, 0.45))
    # sensor noise, blur, colour cast
    img += np.random.default_rng(rnd.randint(0, 1 << 30)).normal(0, 4, img.shape)
    img *= np.array([rnd.uniform(0.92, 1.0), rnd.uniform(0.96, 1.0), rnd.uniform(0.97, 1.05)], np.float32)
    img = np.clip(img, 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (0, 0), rnd.uniform(0.5, 1.1))
    return img, dst


def rotate_with_quad(img, quad, rot_cw):
    """Rotate the delivered image clockwise by rot_cw; quad keeps the upright page's corner order."""
    h, w = img.shape[:2]
    q = quad.copy()
    if rot_cw == 90:
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        q = np.stack([h - 1 - quad[:, 1], quad[:, 0]], 1)
    elif rot_cw == 180:
        img = cv2.rotate(img, cv2.ROTATE_180)
        q = np.stack([w - 1 - quad[:, 0], h - 1 - quad[:, 1]], 1)
    elif rot_cw == 270:
        img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
        q = np.stack([quad[:, 1], w - 1 - quad[:, 0]], 1)
    return img, q


def jpeg(img, q):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])
    return buf.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rnd = random.Random(a.seed)
    manifest = []
    kinds = ["letter", "table", "receipt"]
    for lang in ("en", "ru"):
        for mode in ("scan", "photo", "angled"):
            for rot in (0, 90, 180, 270):
                kind = kinds[(rot // 90 + {"scan": 0, "photo": 1, "angled": 2}[mode]) % 3]
                page, words = render_page(kind, lang, rnd)
                img, quad = capture(page, mode, rnd)
                img, quad = rotate_with_quad(img, quad, rot)
                name = f"doc_{lang}_{mode}_{kind}_r{rot}.jpg"
                open(os.path.join(a.out, name), "wb").write(jpeg(img, 90 if mode == "scan" else 85))
                manifest.append({"file": name, "is_document": True, "lang": lang, "mode": mode, "kind": kind,
                                 "rotated_cw": rot, "fix_rotation": (360 - rot) % 360,
                                 "quad": quad.round(1).tolist(), "words": words})
    for kind in NONDOC_KINDS:
        for i in range(2):
            h, w = (2400, 1800) if i == 0 else (1800, 2400)
            img = nondoc_scene(kind, h, w, rnd)
            name = f"nondoc_{kind}_{i}.jpg"
            open(os.path.join(a.out, name), "wb").write(jpeg(img, 85))
            manifest.append({"file": name, "is_document": False, "kind": kind, "words": []})
    json.dump(manifest, open(os.path.join(a.out, "manifest.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{len(manifest)} images -> {a.out}")


if __name__ == "__main__":
    main()
