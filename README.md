# Safelight Print

A **Print module** for [Safelight](https://github.com/anthonyreimche/SafeLight) (v2.6+). It adds a Print tab beside Library and Develop: lay out a page, preview the selection, and print through the OS dialog.

Requires the [module registry](https://github.com/anthonyreimche/SafeLight/discussions/142) (`registerModule`).

## Features

- Top-level **Print** tab, plus a Library toolbar button and **Ctrl+Shift+P**
- Paper sizes: A3, A4, A5, 10×15, 13×18, 20×30, Letter
- Portrait / landscape, margins (mm), Fit or Fill
- Layouts: 1, 2, 4, 6 photos per page, and contact sheet (4×3)
- Optional captions: filename and/or capture date
- WYSIWYG page preview with page navigation and a selection filmstrip
- Preview and print pixels come from `api.export.renderPhotos` (develop pipeline, including export processors such as watermark / mat / border when those extensions are enabled)
- Print at 300 ppi per cell, via a hidden iframe (no pop-up window)

## Installation

In Safelight → **View → Extensions**, enter:

```
OPGERUIMD97/safelight-print
```

Safelight 2.6.0 or newer is required.

## Usage

1. Select one or more photos in the Library
2. Open the **Print** tab (toolbar button, module strip, or Ctrl+Shift+P)
3. Configure paper, orientation, margins, layout and fit in **Print settings**
4. Click **Print** — the OS print dialog opens

## Limitations

- Color-managed printing (printer ICC, rendering intent, soft proof) is **not** implemented yet. The OS print dialog / driver may apply its own color handling.
- Output sharpening for print is not applied here.
- Preview uses a lighter long-edge than the print render so the tab stays responsive.

## License

MIT
