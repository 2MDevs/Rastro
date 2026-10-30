#!/usr/bin/env python3
"""
Gera os PDFs dos artefatos da plataforma (pasta docs/) na identidade visual RASTRO.

    python3 scripts/build-docs.py

Requisito: reportlab (pip install reportlab). Fontes Poppins e logotipo ficam em docs/fonts e docs/assets.
Fontes de texto: os arquivos .md da pasta docs/. Não inventa datas: a data impressa é a data da geração.
"""
import re
import sys
from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
                                Preformatted, NextPageTemplate, PageBreak, KeepTogether)

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
AMARELO = colors.HexColor("#F6D35C")
GRAFITE = colors.HexColor("#1D1D1B")
CREME = colors.HexColor("#FDF8CF")
CINZA = colors.HexColor("#4A4A4A")
LINHA = colors.HexColor("#E2DED0")
TEXTO = colors.HexColor("#2A2A28")

for name, file in [("Poppins", "Poppins-Regular.ttf"), ("Poppins-Medium", "Poppins-Medium.ttf"),
                   ("Poppins-Bold", "Poppins-Bold.ttf"), ("Poppins-Italic", "Poppins-Italic.ttf")]:
    pdfmetrics.registerFont(TTFont(name, str(DOCS / "fonts" / file)))
pdfmetrics.registerFontFamily("Poppins", normal="Poppins", bold="Poppins-Bold", italic="Poppins-Italic", boldItalic="Poppins-Bold")

S = {
    "body": ParagraphStyle("body", fontName="Poppins", fontSize=9.6, leading=14.5, textColor=TEXTO, spaceAfter=6, alignment=TA_LEFT),
    "h1": ParagraphStyle("h1", fontName="Poppins-Bold", fontSize=18, leading=23, textColor=GRAFITE, spaceBefore=6, spaceAfter=10),
    "h2": ParagraphStyle("h2", fontName="Poppins-Bold", fontSize=13.5, leading=18, textColor=GRAFITE, spaceBefore=14, spaceAfter=6),
    "h3": ParagraphStyle("h3", fontName="Poppins-Medium", fontSize=11, leading=15, textColor=GRAFITE, spaceBefore=10, spaceAfter=4),
    "li": ParagraphStyle("li", fontName="Poppins", fontSize=9.6, leading=14, textColor=TEXTO, leftIndent=14, bulletIndent=3, spaceAfter=2.5),
    "cell": ParagraphStyle("cell", fontName="Poppins", fontSize=8.2, leading=11, textColor=TEXTO),
    "cellh": ParagraphStyle("cellh", fontName="Poppins-Medium", fontSize=8.2, leading=11, textColor=GRAFITE),
    "code": ParagraphStyle("code", fontName="Courier", fontSize=7.6, leading=10, textColor=GRAFITE, backColor=colors.HexColor("#F4F2EA"),
                           borderPadding=6, leftIndent=4, rightIndent=4, spaceBefore=4, spaceAfter=8),
    "quote": ParagraphStyle("quote", fontName="Poppins-Italic", fontSize=9.4, leading=14, textColor=CINZA, leftIndent=10,
                            borderColor=AMARELO, borderWidth=0, spaceAfter=6),
}


def inline(text: str) -> str:
    t = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    t = re.sub(r"`([^`]+)`", r'<font face="Courier" size="8.6">\1</font>', t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<!\w)\*([^*]+)\*(?!\w)", r"<i>\1</i>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", t)
    return t


def parse(md: str):
    lines = md.splitlines()
    flow, i, title = [], 0, None
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("```"):
            buf = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i]); i += 1
            i += 1
            flow.append(Preformatted("\n".join(buf), S["code"]))
            continue
        m = re.match(r"^(#{1,3})\s+(.*)", line)
        if m:
            level, text = len(m.group(1)), m.group(2)
            if level == 1 and title is None:
                title = text
            else:
                flow.append(Paragraph(inline(text), S[f"h{level}"]))
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.match(r"^:?-{3,}:?$", c) for c in cells):
                    rows.append(cells)
                i += 1
            data = [[Paragraph(inline(c), S["cellh" if r == 0 else "cell"]) for c in row] for r, row in enumerate(rows)]
            ncol = max(len(r) for r in rows)
            width = 170 * mm
            t = Table(data, colWidths=[width / ncol] * ncol, repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), CREME),
                ("LINEBELOW", (0, 0), (-1, 0), 1, AMARELO),
                ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINHA),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ]))
            flow += [t, Spacer(1, 8)]
            continue
        if re.match(r"^\s*(- |\* |\d+\. )", line):
            while i < len(lines) and re.match(r"^\s*(- |\* |\d+\. )", lines[i]):
                item = lines[i].strip()
                num = re.match(r"^(\d+)\. (.*)", item)
                box = re.match(r"^- \[( |x)\] (.*)", item)
                if box:
                    flow.append(Paragraph(inline(box.group(2)), S["li"], bulletText="☐" if box.group(1) == " " else "☑"))
                elif num:
                    flow.append(Paragraph(inline(num.group(2)), S["li"], bulletText=f"{num.group(1)}."))
                else:
                    flow.append(Paragraph(inline(item[2:]), S["li"], bulletText="•"))
                i += 1
                # continuação do item (linhas recuadas)
                while i < len(lines) and lines[i].startswith("   ") and not re.match(r"^\s*(- |\d+\. )", lines[i]):
                    i += 1
            flow.append(Spacer(1, 4))
            continue
        if line.startswith(">"):
            flow.append(Paragraph(inline(line.lstrip("> ")), S["quote"]))
            i += 1
            continue
        buf = [line.strip()]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#|\||```|>|\s*(- |\* |\d+\. ))", lines[i]):
            buf.append(lines[i].strip()); i += 1
        flow.append(Paragraph(inline(" ".join(buf)), S["body"]))
    return title, flow


def build(md_file: str, pdf_file: str, subtitle: str, version: str):
    title, flow = parse((DOCS / md_file).read_text(encoding="utf-8"))
    today = date.today().strftime("%d/%m/%Y")
    out = DOCS / pdf_file
    W, H = A4

    def cover(c, doc):
        c.saveState()
        c.setFillColor(GRAFITE); c.rect(0, 0, W, H, stroke=0, fill=1)
        c.setStrokeColor(colors.HexColor("#2E2E2B")); c.setLineWidth(0.6)
        for k in range(14):  # malha de ruas decorativa, discreta
            c.line(-20, 120 + k * 52, W + 20, 90 + k * 52 + (k % 3) * 9)
        for k in range(10):
            c.line(30 + k * 62, -20, 10 + k * 62 + (k % 4) * 8, H + 20)
        c.drawImage(str(DOCS / "assets" / "logo-fundo-escuro.png"), 22 * mm, H - 70 * mm, width=110 * mm, height=110 * mm * 0.2368, mask="auto")
        c.setFillColor(AMARELO); c.setFont("Poppins-Medium", 8.5)
        c.drawString(22 * mm + 110 * mm * 0.2246, H - 75 * mm, "I N T E L I G Ê N C I A   E M   M O V I M E N T O .")
        c.setFillColor(colors.white); c.setFont("Poppins-Bold", 26)
        c.drawString(22 * mm, 110 * mm, title or "RASTRO")
        c.setFillColor(colors.HexColor("#B9B6AA")); c.setFont("Poppins", 11)
        c.drawString(22 * mm, 100 * mm, subtitle)
        c.setFillColor(AMARELO); c.rect(22 * mm, 92 * mm, 18 * mm, 1.2 * mm, stroke=0, fill=1)
        c.setFillColor(colors.HexColor("#B9B6AA")); c.setFont("Poppins", 9)
        c.drawString(22 * mm, 34 * mm, f"Versão {version}  ·  Gerado em {today}")
        c.drawString(22 * mm, 28 * mm, "Responsável técnico: Marcos Monteiro — TI da Hummm! Pizzas")
        c.drawString(22 * mm, 22 * mm, "Uso interno")
        c.restoreState()

    def page(c, doc):
        c.saveState()
        c.drawImage(str(DOCS / "assets" / "logo-fundo-claro.png"), 20 * mm, H - 16 * mm, width=30 * mm, height=30 * mm * 0.2368, mask="auto")
        c.setFillColor(CINZA); c.setFont("Poppins", 7.5)
        c.drawRightString(W - 20 * mm, H - 14.2 * mm, title or "")
        c.setStrokeColor(AMARELO); c.setLineWidth(1.2); c.line(20 * mm, H - 19 * mm, W - 20 * mm, H - 19 * mm)
        c.setFillColor(CINZA); c.setFont("Poppins", 7.5)
        c.drawString(20 * mm, 12 * mm, f"RASTRO · {subtitle} · v{version}")
        c.drawRightString(W - 20 * mm, 12 * mm, f"Página {doc.page - 1}")
        c.restoreState()

    doc = BaseDocTemplate(str(out), pagesize=A4, title=f"RASTRO — {title}", author="TI da Hummm! Pizzas",
                          leftMargin=20 * mm, rightMargin=20 * mm, topMargin=26 * mm, bottomMargin=20 * mm)
    frame_cover = Frame(0, 0, W, H, id="cover")
    frame_body = Frame(20 * mm, 20 * mm, W - 40 * mm, H - 46 * mm, id="body")
    doc.addPageTemplates([PageTemplate(id="cover", frames=[frame_cover], onPage=cover),
                          PageTemplate(id="body", frames=[frame_body], onPage=page)])
    doc.build([NextPageTemplate("body"), PageBreak()] + flow)
    print(f"  {pdf_file}")


if __name__ == "__main__":
    version = "0.1.0"
    print("Gerando PDFs em docs/ ...")
    build("documentacao-do-projeto.md", "RASTRO-Documentacao-do-Projeto.pdf", "Documentação do projeto", version)
    build("manual-rapido.md", "RASTRO-Manual-Rapido.pdf", "Manual rápido do usuário", version)
    build("roteiro-de-testes.md", "RASTRO-Roteiro-de-Testes.pdf", "Roteiro de testes", version)
    build("metodologia-cobertura.md", "RASTRO-Metodologia-de-Cobertura.pdf", "Metodologia de cobertura", version)
    build("notas-de-versao.md", "RASTRO-Notas-de-Versao.pdf", "Notas de versão", version)
    sys.exit(0)
