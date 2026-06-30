import os
import re
import uuid
import tempfile
from google.genai import Client
from fpdf import FPDF
from dotenv import load_dotenv

# Initialize the client
load_dotenv()
client = Client(api_key=os.getenv("API_KEY"))

for model in client.models.list():
    print(model.name)


# ---------------------------------------------------------------------------
# Text cleanup
# ---------------------------------------------------------------------------

def clean_text_for_pdf(text: str) -> str:
    """Replaces characters that common PDF fonts can't handle."""
    return text.encode("latin-1", "replace").decode("latin-1")


# ---------------------------------------------------------------------------
# Markdown -> styled PDF renderer
# ---------------------------------------------------------------------------

PRIMARY_COLOR = (30, 30, 30)      # body text
HEADING_COLOR = (20, 60, 120)     # headings
ACCENT_COLOR = (90, 90, 90)       # bullets / muted text

BASE_FONT_SIZE = 11
LINE_HEIGHT = 7


def _write_inline_bold(pdf: FPDF, text: str, size: int = BASE_FONT_SIZE):
    """
    Writes a single line, toggling bold for **text** segments,
    then moves to a new line.
    """
    text = clean_text_for_pdf(text)
    parts = re.split(r"(\*\*.*?\*\*)", text)
    pdf.set_text_color(*PRIMARY_COLOR)

    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            pdf.set_font("helvetica", "B", size)
            pdf.write(LINE_HEIGHT, part[2:-2])
        else:
            pdf.set_font("helvetica", "", size)
            pdf.write(LINE_HEIGHT, part)

    pdf.ln(LINE_HEIGHT)


def render_markdown_to_pdf(pdf: FPDF, markdown_text: str):
    """
    Minimal but effective Markdown renderer for #, ##, -, *, **bold**,
    and blank-line spacing. Good enough for AI-generated notes.
    """
    lines = markdown_text.split("\n")

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()

        # Blank line -> small vertical gap
        if stripped == "":
            pdf.ln(3)
            continue

        # H1
        if stripped.startswith("# "):
            pdf.set_text_color(*HEADING_COLOR)
            pdf.set_font("helvetica", "B", 18)
            pdf.ln(4)
            pdf.multi_cell(0, 10, clean_text_for_pdf(stripped[2:]))
            # underline rule
            pdf.set_draw_color(*HEADING_COLOR)
            pdf.set_line_width(0.6)
            y = pdf.get_y() + 1
            pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
            pdf.ln(6)
            continue

        # H2
        if stripped.startswith("## "):
            pdf.set_text_color(*HEADING_COLOR)
            pdf.set_font("helvetica", "B", 14)
            pdf.ln(3)
            pdf.multi_cell(0, 8, clean_text_for_pdf(stripped[3:]))
            pdf.ln(2)
            continue

        # H3
        if stripped.startswith("### "):
            pdf.set_text_color(*HEADING_COLOR)
            pdf.set_font("helvetica", "B", 12)
            pdf.multi_cell(0, 7, clean_text_for_pdf(stripped[4:]))
            pdf.ln(1)
            continue

        # Bullet points
        if stripped.startswith("- ") or stripped.startswith("* "):
            content = stripped[2:]
            pdf.set_text_color(*ACCENT_COLOR)
            pdf.set_font("helvetica", "B", BASE_FONT_SIZE)
            pdf.set_x(pdf.l_margin + 4)
            pdf.write(LINE_HEIGHT, "- ")
            _write_inline_bold(pdf, content)
            continue

        # Numbered list ("1. text")
        match = re.match(r"^(\d+)\.\s+(.*)", stripped)
        if match:
            number, content = match.groups()
            pdf.set_x(pdf.l_margin + 4)
            pdf.set_text_color(*ACCENT_COLOR)
            pdf.set_font("helvetica", "B", BASE_FONT_SIZE)
            pdf.write(LINE_HEIGHT, f"{number}. ")
            _write_inline_bold(pdf, content)
            continue

        # Regular paragraph (may still contain **bold**)
        pdf.set_x(pdf.l_margin)
        _write_inline_bold(pdf, stripped)

    pdf.set_text_color(0, 0, 0)


# ---------------------------------------------------------------------------
# Core note-generation logic
# ---------------------------------------------------------------------------

def generate_notes(transcript_text: str):
    try:
        # 1. Get AI response, explicitly asking for Markdown structure
        prompt = (
            "You are an expert at simplifying complex content. I will give you a transcript "
            "from a video. Convert it into structured study notes.\n\n"
            "Respond ONLY in Markdown, using EXACTLY this structure (no extra commentary, "
            "no code fences, no XML):\n\n"
            "# AI Study Notes\n\n"
            "## Summary\n"
            "A concise summary (5-8 sentences) covering the key points of the video.\n\n"
            "## Simple Explanation\n"
            "Explain the content as if talking to a curious 5-year-old with no prior "
            "knowledge of the topic. Use simple language, relatable analogies, and short "
            "paragraphs.\n\n"
            "## Key Takeaways\n"
            "- First key takeaway\n"
            "- Second key takeaway\n"
            "- (3-5 bullet points total, each one sentence)\n\n"
            "Use **bold** to highlight important terms throughout.\n\n"
            "Here is the transcript:\n"
            f"{transcript_text}"
        )

        response = client.models.generate_content(
            model="gemini-flash-latest",
            contents=prompt,
        )

        if not response.text:
            return {"error": "Gemini returned an empty response."}

        ai_notes = response.text.strip()

        # Strip accidental code fences if the model adds them anyway
        ai_notes = re.sub(r"^```(?:markdown|md)?\n?", "", ai_notes)
        ai_notes = re.sub(r"\n?```$", "", ai_notes)

        # 2. Build a styled PDF from the markdown
        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_page()

        render_markdown_to_pdf(pdf, ai_notes)

        # 3. Save to temp folder
        file_id = str(uuid.uuid4())[:8]
        file_path = os.path.join(tempfile.gettempdir(), f"notes_{file_id}.pdf")
        pdf.output(file_path)

        return {"download_url": f"http://127.0.0.1:8000/download/{file_id}"}

    except Exception as e:
        print(f"CRITICAL ERROR IN GEMINI.PY: {e}")
        return {"error": str(e)}


def get_pdf_path(file_id: str):
    return os.path.join(tempfile.gettempdir(), f"notes_{file_id}.pdf")