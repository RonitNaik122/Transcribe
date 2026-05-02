import os
import uuid
import tempfile
from google.genai import Client
from fpdf import FPDF
from dotenv import load_dotenv

# Initialize the client
load_dotenv()
client = Client(api_key = os.getenv("API_KEY"))

for model in client.models.list():
    print(model.name)

def clean_text_for_pdf(text):
    """Replaces characters that common PDF fonts can't handle."""
    return text.encode('latin-1', 'replace').decode('latin-1')

def generate_notes(transcript_text: str):
    try:
        # 1. Get AI Response
        prompt = (
            "Summarize this transcript into structured study notes with "
            "clear headings for Key Concepts and a Detailed Summary:\n\n"
            f"{transcript_text}"
        )

        response = client.models.generate_content(
            model="gemini-flash-latest", 
            contents=f"Summarize this: {transcript_text}"
        )

        if not response.text:
            return {"error": "Gemini returned an empty response."}
        
        ai_notes = response.text

        # 2. Create PDF safely
        pdf = FPDF()
        pdf.add_page()
        
        # Use a standard font
        pdf.set_font("helvetica", "B", 16)
        pdf.cell(0, 10, "AI Study Notes", ln=True, align="C")
        pdf.ln(10)
        
        pdf.set_font("helvetica", size=11)
        
        # CLEAN THE TEXT: This prevents the 500 error during PDF generation
        safe_content = clean_text_for_pdf(ai_notes)
        pdf.multi_cell(0, 10, safe_content)

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