"""Capture pages from a Windows Image Acquisition (WIA) scanner with Duplex, DPI & Auto-Crop support."""

from __future__ import annotations
import sys
import tempfile
import uuid
import json
from pathlib import Path
import cv2
import numpy as np

WIA_DEVICE_TYPE_SCANNER = 1
WIA_FORMAT_BMP = "{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}"
WIA_DPS_DOCUMENT_HANDLING_SELECT = 3088
FEEDER_AND_DUPLEX = 5  # 1 (Feeder) + 4 (Duplex)
FEEDER_ONLY = 1

WIA_IPS_PAGE_SIZE = 3097
WIA_PAGE_A4 = 0
WIA_IPS_XRES = 6147
WIA_IPS_YRES = 6148
WIA_IPS_XPOS = 6149
WIA_IPS_YPOS = 6150
WIA_IPS_XEXTENT = 6151
WIA_IPS_YEXTENT = 6152


def get_scanners() -> list[dict]:
    if sys.platform != "win32":
        return []
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        return []

    pythoncom.CoInitialize()
    scanners = []
    try:
        dev_manager = win32com.client.Dispatch("WIA.DeviceManager")
        for info in dev_manager.DeviceInfos:
            if info.Type == WIA_DEVICE_TYPE_SCANNER:
                scanners.append({
                    "id": info.DeviceID,
                    "name": info.Properties("Name").Value
                })
        return scanners
    finally:
        pythoncom.CoUninitialize()


def order_points_py(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def warp_box(img: np.ndarray, box: np.ndarray) -> np.ndarray:
    rect = order_points_py(np.array(box, dtype="float32"))
    (tl, tr, br, bl) = rect

    widthA = np.hypot(br[0] - bl[0], br[1] - bl[1])
    widthB = np.hypot(tr[0] - tl[0], tr[1] - tl[1])
    maxWidth = max(int(round(max(widthA, widthB))), 20)

    heightA = np.hypot(tr[0] - br[0], tr[1] - br[1])
    heightB = np.hypot(tl[0] - bl[0], tl[1] - bl[1])
    maxHeight = max(int(round(max(heightA, heightB))), 20)

    dst = np.array([
        [0, 0],
        [maxWidth - 1, 0],
        [maxWidth - 1, maxHeight - 1],
        [0, maxHeight - 1]
    ], dtype="float32")

    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(
        img, M, (maxWidth, maxHeight),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE
    )


def set_wia_prop(obj, pid: int, value: int) -> bool:
    try:
        for p in obj.Properties:
            if p.PropertyID == pid:
                p.Value = value
                return True
    except Exception:
        pass
    return False


def get_wia_prop(obj, pid: int, default=None):
    try:
        for p in obj.Properties:
            if p.PropertyID == pid:
                return p.Value
    except Exception:
        pass
    return default


def configure_scanner_item(device, item, dpi: int = 300, is_flatbed: bool = False) -> None:
    set_wia_prop(item, WIA_IPS_XRES, dpi)
    set_wia_prop(item, WIA_IPS_YRES, dpi)

    if not is_flatbed:
        for owner in (device, item):
            if set_wia_prop(owner, WIA_IPS_PAGE_SIZE, WIA_PAGE_A4):
                break
        cur_xres = get_wia_prop(item, WIA_IPS_XRES, dpi) or dpi
        cur_yres = get_wia_prop(item, WIA_IPS_YRES, cur_xres) or cur_xres
        set_wia_prop(item, WIA_IPS_XPOS, 0)
        set_wia_prop(item, WIA_IPS_YPOS, 0)
        set_wia_prop(item, WIA_IPS_XEXTENT, int(round(8.268 * cur_xres)))
        set_wia_prop(item, WIA_IPS_YEXTENT, int(round(11.693 * cur_yres)))


def trim_feeder_overflow(img: np.ndarray, side_hint: str = "top", tol: float = 1.06) -> np.ndarray:
    if img is None:
        return img
    h, w = img.shape[:2]
    if w == 0 or h == 0:
        return img

    dpi = w / 8.5 if (h / w) > 1.55 else w / 8.268
    exp_h = int(round(11.693 * dpi))
    if h <= exp_h * tol or exp_h <= 0 or exp_h >= h:
        return img

    extra = h - exp_h
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    blank = lambda band: (band < 235).mean() < 0.002

    top_blank = blank(gray[:extra])
    bot_blank = blank(gray[-extra:])

    if top_blank and not bot_blank:
        return img[extra:]
    if bot_blank and not top_blank:
        return img[:exp_h]
    if top_blank and bot_blank:
        return img[extra:] if side_hint == "top" else img[:exp_h]
    return img


def is_blank_page(img: np.ndarray, thresh: float = 0.003) -> bool:
    if img is None:
        return True
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    h, w = g.shape[:2]
    m_y, m_x = max(1, int(h * 0.03)), max(1, int(w * 0.03))
    if h <= 2 * m_y or w <= 2 * m_x:
        return False
    return float((g[m_y:-m_y, m_x:-m_x] < 200).mean()) < thresh


def detect_corners(image_path: Path) -> list[dict]:
    img = cv2.imread(str(image_path))
    if img is None:
        return [{"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.1}, {"x": 0.9, "y": 0.9}, {"x": 0.1, "y": 0.9}]

    orig_h, orig_w = img.shape[:2]
    max_dim = 800
    scale = min(1.0, max_dim / max(orig_h, orig_w))
    w, h = int(orig_w * scale), int(orig_h * scale)
    resized = cv2.resize(img, (w, h))
    total_area = w * h

    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)

    best_box = None
    best_area = 0

    for low, high in [(30, 100), (50, 150), (20, 80)]:
        edges = cv2.Canny(blurred, low, high)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
        closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for c in contours:
            area = cv2.contourArea(c)
            if (total_area * 0.04) < area < (total_area * 0.92):
                peri = cv2.arcLength(c, True)
                approx = cv2.approxPolyDP(c, 0.02 * peri, True)
                if len(approx) == 4 and area > best_area:
                    best_area = area
                    best_box = approx.reshape(4, 2)
                elif area > best_area:
                    rect = cv2.minAreaRect(c)
                    best_area = area
                    best_box = np.array(cv2.boxPoints(rect), dtype="float32")

    if best_box is None:
        _, thresh = cv2.threshold(blurred, 235, 255, cv2.THRESH_BINARY_INV)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
        closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            area = cv2.contourArea(c)
            if (total_area * 0.04) < area < (total_area * 0.92) and area > best_area:
                rect = cv2.minAreaRect(c)
                best_box = np.array(cv2.boxPoints(rect), dtype="float32")
                best_area = area

    try:
        image_path.unlink()
    except Exception:
        pass

    if best_box is not None:
        ordered = order_points_py(best_box)
        result = []
        for pt in ordered:
            nx = float(np.clip(pt[0] / w, 0.02, 0.98))
            ny = float(np.clip(pt[1] / h, 0.02, 0.98))
            result.append({"x": nx, "y": ny})
        return result

    return [{"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.1}, {"x": 0.9, "y": 0.9}, {"x": 0.1, "y": 0.9}]


def save_as_jpg(img: np.ndarray, parent_dir: Path, prefix: str = "page") -> str:
    jpg_path = parent_dir / f"{prefix}_{uuid.uuid4().hex}.jpg"
    cv2.imwrite(str(jpg_path), img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    return str(jpg_path.resolve())


def process_and_crop(image_path: Path) -> list[str]:
    img = cv2.imread(str(image_path))
    if img is None:
        return [str(image_path)]

    orig_h, orig_w = img.shape[:2]
    max_dim = 800
    scale = min(1.0, max_dim / max(orig_h, orig_w))
    w, h = int(orig_w * scale), int(orig_h * scale)
    small = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
    small_area = w * h

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 242, 255, cv2.THRESH_BINARY_INV)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_x, min_y = w, h
    max_x, max_y = 0, 0
    valid_contours = []

    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        if (bw * bh) > (small_area * 0.015):
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x + bw)
            max_y = max(max_y, y + bh)
            valid_contours.append(c)

    span_width = max_x - min_x
    span_height = max_y - min_y

    def return_full_jpg() -> list[str]:
        out_jpg = save_as_jpg(img, image_path.parent, "scan")
        try:
            image_path.unlink()
        except Exception:
            pass
        return [out_jpg]

    if len(valid_contours) > 5 or (span_width > w * 0.85) or (span_height > h * 0.85) or (span_width > w * 0.60 and span_height > h * 0.60):
        return return_full_jpg()

    valid_quads = []
    for c in valid_contours:
        x, y, bw, bh = cv2.boundingRect(c)
        if (bw * bh > small_area * 0.22) or (bw > w * 0.65) or (bh > h * 0.65):
            return return_full_jpg()

        aspect = max(bw, bh) / max(1, min(bw, bh))
        if aspect < 3.2:
            rect = cv2.minAreaRect(c)
            box = cv2.boxPoints(rect)
            orig_box = np.array(box, dtype="float32") / scale
            valid_quads.append((y, x, orig_box))

    if not valid_quads:
        return return_full_jpg()

    valid_quads.sort(key=lambda item: (int(item[0] // 100), item[1]))

    cropped_paths = []
    for _, _, orig_box in valid_quads:
        warped = warp_box(img, orig_box)
        cropped_paths.append(save_as_jpg(warped, image_path.parent, "crop"))

    try:
        image_path.unlink()
    except Exception:
        pass

    return cropped_paths


def scan_pages(device_id: str = None, dpi: int = 300, use_duplex: bool = True) -> tuple[list[Path], bool]:
    if sys.platform != "win32":
        raise RuntimeError("The Smart Scanner hardware bridge requires Windows.")

    try:
        import pythoncom
        import win32com.client
    except ImportError as error:
        raise RuntimeError("pywin32 is missing.") from error

    pythoncom.CoInitialize()
    try:
        if device_id:
            dev_manager = win32com.client.Dispatch("WIA.DeviceManager")
            device = None
            for info in dev_manager.DeviceInfos:
                if info.DeviceID == device_id:
                    device = info.Connect()
                    break
            if device is None:
                raise RuntimeError("Scanner not found.")
        else:
            dialog = win32com.client.Dispatch("WIA.CommonDialog")
            device = dialog.ShowSelectDevice(WIA_DEVICE_TYPE_SCANNER, False, True)
            if device is None:
                raise RuntimeError("No scanner was selected.")
            
        if device.Items.Count < 1:
            raise RuntimeError("The selected scanner has no scan source.")

        def apply_feeder_and_duplex(dev, item_obj, duplex_mode: bool) -> bool:
            """إجبار تعريفات HP و WIA على تفعيل الفيدر والوجهين معاً"""
            feeder_active = False
            # القيم المحتملة للدوبلكس حسب اختلاف تعريفات HP (5 = Feeder+Duplex, 4 = Duplex, 33 = Front+Back)
            duplex_candidates = [5, 4, 33] if duplex_mode else [1]
            
            for target in (dev, item_obj):
                if target is None:
                    continue
                try:
                    for prop in target.Properties:
                        # 3088 = WIA_DPS_DOCUMENT_HANDLING_SELECT
                        if prop.PropertyID == 3088:
                            for val in duplex_candidates:
                                try:
                                    prop.Value = val
                                    feeder_active = True
                                    break
                                except Exception:
                                    continue
                            if not feeder_active and duplex_mode:
                                try:
                                    prop.Value = 1  # FEEDER_ONLY fallback
                                    feeder_active = True
                                except Exception:
                                    pass
                        # 3096 = WIA_DPS_PAGES (مهم جداً لطابعات HP لقراءة الظهر وعدم التوقف عند الوجه الأول)
                        elif prop.PropertyID == 3096:
                            try:
                                prop.Value = 0  # 0 = سحب كل الأوراق والأوجه المتاحة بالفيدر
                            except Exception:
                                try:
                                    prop.Value = 2 if duplex_mode else 1
                                except Exception:
                                    pass
                except Exception:
                    pass
            return feeder_active

        item = device.Items.Item(1)

        # 1. التفعيل المبدئي للفيدر والدوبلكس
        is_feeder = apply_feeder_and_duplex(device, item, use_duplex)
        is_flatbed = not is_feeder

        # 2. ضبط مقاس الورقة A4 والدقة DPI
        configure_scanner_item(device, item, dpi=dpi, is_flatbed=is_flatbed)

        # 3. إعادة فرض الدوبلكس وعدد الصفحات بعد ضبط A4 (لأن HP يصفّر الإعدادات بعد تغيير المقاس)
        if not is_flatbed:
            item = device.Items.Item(1)
            apply_feeder_and_duplex(device, item, use_duplex)

        output_directory = Path(tempfile.gettempdir()) / "smart-scanner"
        output_directory.mkdir(parents=True, exist_ok=True)
        scanned_files = []

        if is_flatbed:
            image = item.Transfer(WIA_FORMAT_BMP)
            output_path = output_directory / f"raw-{uuid.uuid4().hex}.bmp"
            image.SaveFile(str(output_path))
            scanned_files.append(output_path.resolve())
        else:
            # حلقة سحب مستمرة لسحب الوجه الأول ثم الوجه الثاني وبقية الأوراق في الفيدر
            while True:
                try:
                    image = item.Transfer(WIA_FORMAT_BMP)
                    output_path = output_directory / f"raw-{uuid.uuid4().hex}.bmp"
                    image.SaveFile(str(output_path))
                    scanned_files.append(output_path.resolve())
                except Exception as exc:
                    # في بعض طابعات HP يحتاج الوجه الثاني أو الورقة التالية إعادة طلب من Item(2) أو Item(1)
                    if use_duplex and len(scanned_files) % 2 == 1 and device.Items.Count >= 2:
                        try:
                            item2 = device.Items.Item(2)
                            image = item2.Transfer(WIA_FORMAT_BMP)
                            output_path = output_directory / f"raw-{uuid.uuid4().hex}.bmp"
                            image.SaveFile(str(output_path))
                            scanned_files.append(output_path.resolve())
                            continue
                        except Exception:
                            pass
                    if not scanned_files:
                        raise RuntimeError(f"Feeder scan failed or feeder is empty: {exc}") from exc
                    break

        if not scanned_files:
            raise RuntimeError("No pages were scanned. Feeder might be empty or device is busy.")

        return scanned_files, is_flatbed
    finally:
        pythoncom.CoUninitialize()


if __name__ == "__main__":
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "list":
            print(json.dumps(get_scanners()), flush=True)
        elif len(sys.argv) > 2 and sys.argv[1] == "process":
            image_path = Path(sys.argv[2])
            final_images = process_and_crop(image_path)
            print(json.dumps(final_images), flush=True)
        elif len(sys.argv) > 2 and sys.argv[1] == "corners":
            image_path = Path(sys.argv[2])
            corners = detect_corners(image_path)
            print(json.dumps(corners), flush=True)
        else:
            if len(sys.argv) > 1 and sys.argv[1] == "scan":
                device_id = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
                dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 300
                use_duplex = (sys.argv[4] != "simplex") if len(sys.argv) > 4 else True
            else:
                device_id = sys.argv[1] if len(sys.argv) > 1 else None
                dpi = 300
                use_duplex = True

            original_image_paths, is_flatbed = scan_pages(device_id, dpi=dpi, use_duplex=use_duplex)
            
            all_final_images = []
            for img_path in original_image_paths:
                if not is_flatbed:
                    img = cv2.imread(str(img_path))
                    if img is not None:
                        img = trim_feeder_overflow(img)
                        if is_blank_page(img):
                            try:
                                img_path.unlink()
                            except Exception:
                                pass
                            continue
                        cv2.imwrite(str(img_path), img)
                
                final_images = process_and_crop(img_path)
                all_final_images.extend(final_images)
            
            print(json.dumps(all_final_images), flush=True)
            
    except Exception as error:
        print(f"Smart Scanner: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1) from error