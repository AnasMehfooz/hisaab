"""
Hisab Local AI Receipt Reader Service
Runs locally on your machine utilizing Ollama + RTX 5060 Ti eGPU.

Usage:
  python receipt_reader_server.py
"""

import base64
import json
import re
import urllib.request
import urllib.parse
from flask import Flask, request, jsonify

app = Flask(__name__)

OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
MODEL_NAME = "llava"

PROMPT = """
You are a high-accuracy receipt OCR scanner and translator.
Analyze this receipt image carefully. Extract all purchased items along with their total final price in euros.

IMPORTANT: If the receipt item names are in a language OTHER THAN English (such as German, Dutch, French, Spanish, Arabic, etc.), TRANSLATE EVERY ITEM NAME TO CLEAR ENGLISH!

Return strictly valid JSON matching this format:
{
  "items": [
    {
      "name": "English Item Name", 
      "original_name": "Original Name on Receipt if different",
      "price": 4.99
    }
  ]
}

Rules:
1. "name" MUST BE IN ENGLISH. Translate non-English words into natural English (e.g., "Milch 1.5%" -> "Milk 1.5%", "Brot" -> "Bread", "Wasser" -> "Water").
2. "price" must be a float (e.g. 4.99, not "4.99 €").
3. Do NOT include subtotal, tax, card payment lines, or store info.
4. Output ONLY valid JSON, with no markdown code blocks or extra text.
"""

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "gpu_model": MODEL_NAME})

@app.route("/read-receipt", methods=["POST"])
def read_receipt():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    img_bytes = file.read()
    b64_image = base64.b64encode(img_bytes).decode("utf-8")

    payload = json.dumps({
        "model": MODEL_NAME,
        "prompt": PROMPT,
        "images": [b64_image],
        "stream": False
    }).encode("utf-8")

    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
            raw_text = result.get("response", "")

            cleaned_text = re.sub(r"```json\s*", "", raw_text)
            cleaned_text = re.sub(r"```\s*", "", cleaned_text).strip()

            parsed = json.loads(cleaned_text)
            return jsonify(parsed)
    except Exception as e:
        return jsonify({"error": f"Error processing receipt: {str(e)}"}), 500

if __name__ == "__main__":
    print("Hisab Local GPU Receipt Reader running on http://127.0.0.1:8001")
    app.run(host="127.0.0.1", port=8001, debug=False)
