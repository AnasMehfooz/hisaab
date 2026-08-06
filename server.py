"""
Hisab Web Application Server with AI Receipt OCR & SQLite Persistence
Runs on Render.com or Localhost.
"""

import os, json, re, sqlite3, base64, urllib.request
from datetime import datetime
from flask import Flask, send_from_directory, request, jsonify

app = Flask(__name__, static_folder=".")
app.secret_key = "hisab_secret_key_local"

DB_PATH = os.environ.get("DB_PATH", "database.db")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
LOCAL_AI_URL = os.environ.get("LOCAL_AI_URL", "http://127.0.0.1:8001/read-receipt")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        c = conn.cursor()
        c.execute("CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        c.execute("CREATE TABLE IF NOT EXISTS bills (id TEXT PRIMARY KEY, payer_id TEXT NOT NULL, uploaded_by_id TEXT, month TEXT NOT NULL, created_at TEXT NOT NULL, image_path TEXT)")
        c.execute("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, bill_id TEXT NOT NULL, name TEXT NOT NULL, price REAL NOT NULL, assignee_ids TEXT NOT NULL, needs_review INTEGER DEFAULT 0, translation TEXT, FOREIGN KEY (bill_id) REFERENCES bills (id) ON DELETE CASCADE)")
        c.execute("CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL, details TEXT, bill_image_path TEXT)")
        c.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        c.execute("SELECT COUNT(*) FROM people")
        if c.fetchone()[0] == 0:
            c.executemany("INSERT INTO people (id, name) VALUES (?, ?)", [("p1","Omar"),("p2","Sarah"),("p3","Alex")])
        conn.commit()

init_db()

def get_setting(key_name, default=""):
    with get_db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key_name,)).fetchone()
        if row and row["value"]: return row["value"]
    return os.environ.get(key_name, default)

def process_receipt_with_ai(image_bytes, content_type="image/jpeg"):
    b64_img = base64.b64encode(image_bytes).decode("utf-8")
    gemini_key = get_setting("GEMINI_API_KEY", GEMINI_API_KEY)
    print(f"[AI] Key prefix: {gemini_key[:8] if gemini_key else 'NONE'}")

    # 1. Gemini Vision API
    if gemini_key:
        for model in ["gemini-2.0-flash-001", "gemini-2.0-flash-lite", "gemini-flash-latest"]:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
                prompt = (
                    "You are a receipt scanner. Extract every purchased line item and its price in euros. "
                    "Translate all item names to English. "
                    "Return ONLY valid JSON with no other text: "
                    "{\"items\": [{\"name\": \"English item name\", \"original_name\": \"text from receipt\", \"price\": 1.99}]}"
                )
                payload = json.dumps({
                    "contents": [{"parts": [{"text": prompt}, {"inline_data": {"mime_type": content_type, "data": b64_img}}]}],
                    "generationConfig": {"temperature": 0.1}
                }).encode("utf-8")
                req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=25) as resp:
                    res_data = json.loads(resp.read().decode("utf-8"))
                    text_out = res_data["candidates"][0]["content"]["parts"][0]["text"]
                    print(f"[AI] Gemini {model}: {text_out[:200]}")
                    cleaned = re.sub(r"```json\s*", "", text_out)
                    cleaned = re.sub(r"```\s*", "", cleaned).strip()
                    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
                    if m:
                        parsed = json.loads(m.group(0))
                        if parsed.get("items"):
                            print(f"[AI] Gemini extracted {len(parsed['items'])} items!")
                            return parsed["items"]
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8")
                print(f"[AI] Gemini {model} HTTP {e.code}: {err_body[:150]}")
                if e.code == 429:
                    break
            except Exception as e:
                print(f"[AI] Gemini {model} error: {e}")

    # 2. OCR.space free fallback (500 req/month, no daily quota)
    try:
        ocrspace_key = get_setting("OCRSPACE_API_KEY", "K81962337288957")
        boundary = "----OCRSpaceBoundary"
        body = (
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"base64Image\"\r\n\r\n"
            f"data:{content_type};base64,{b64_img}\r\n"
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"language\"\r\n\r\neng\r\n"
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"isOverlayRequired\"\r\n\r\nfalse\r\n"
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"apikey\"\r\n\r\n{ocrspace_key}\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")
        req = urllib.request.Request(
            "https://api.ocr.space/parse/image", data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            ocr_data = json.loads(resp.read().decode("utf-8"))
            ocr_text = ocr_data.get("ParsedResults", [{}])[0].get("ParsedText", "")
            if ocr_text:
                print(f"[AI] OCR.space text: {ocr_text[:300]}")
                items = []
                skip_words = ["summe","total","mwst","ust","brutto","netto","bezahl","karte","posten","anzahl","inkl","exkl"]
                for line in ocr_text.split("\n"):
                    line = line.strip()
                    pm = re.search(r"(\d+[,\.]\d{2})\s*$", line)
                    if pm:
                        price = float(pm.group(1).replace(",", "."))
                        name = line[:pm.start()].strip()
                        if name and price > 0 and not any(s in name.lower() for s in skip_words):
                            items.append({"name": name, "original_name": name, "price": price})
                if items:
                    print(f"[AI] OCR.space extracted {len(items)} items!")
                    return items
    except Exception as e:
        print(f"[AI] OCR.space error: {e}")

    # 3. Local GPU fallback
    try:
        boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"receipt.jpg\"\r\nContent-Type: {content_type}\r\n\r\n").encode("utf-8") + image_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
        req = urllib.request.Request(LOCAL_AI_URL, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            if resp.status == 200:
                res_data = json.loads(resp.read().decode("utf-8"))
                if res_data.get("items"):
                    return res_data["items"]
    except Exception:
        pass

    print("[AI] All methods failed.")
    return [{"name": "Could not read receipt — please add items manually", "price": 0.00}]

@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(".", filename)

@app.route("/api/settings", methods=["GET", "POST"])
def settings_api():
    with get_db() as conn:
        if request.method == "POST":
            data = request.json or {}
            gkey = data.get("gemini_key", "").strip()
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('GEMINI_API_KEY', ?)", (gkey,))
            conn.commit()
            return jsonify({"success": True})
        gkey = get_setting("GEMINI_API_KEY")
        masked = (gkey[:6] + "..." + gkey[-4:]) if len(gkey) > 10 else gkey
        return jsonify({"gemini_key_set": bool(gkey), "masked_key": masked})

@app.route("/api/session", methods=["GET"])
def get_session():
    with get_db() as conn:
        p = conn.execute("SELECT id, name FROM people LIMIT 1").fetchone()
        return jsonify({"authenticated": True, "person_id": p["id"] if p else "p1", "name": p["name"] if p else "Omar"})

@app.route("/api/setup/needed", methods=["GET"])
def setup_needed():
    return jsonify({"needed": False})

@app.route("/api/login", methods=["POST"])
def login():
    data = request.json or {}
    name = data.get("name", "User").strip()
    with get_db() as conn:
        p = conn.execute("SELECT * FROM people WHERE LOWER(name) = LOWER(?)", (name,)).fetchone()
        if not p:
            new_id = f"p_{int(datetime.now().timestamp())}"
            conn.execute("INSERT INTO people (id, name) VALUES (?, ?)", (new_id, name))
            conn.commit()
            return jsonify({"success": True, "person_id": new_id, "name": name})
        return jsonify({"success": True, "person_id": p["id"], "name": p["name"]})

@app.route("/api/logout", methods=["POST"])
def logout():
    return jsonify({"success": True})

@app.route("/api/people", methods=["GET", "POST"])
def manage_people():
    with get_db() as conn:
        if request.method == "POST":
            data = request.json or {}
            name = data.get("name", "Roommate").strip()
            new_id = f"p_{int(datetime.now().timestamp())}"
            conn.execute("INSERT INTO people (id, name) VALUES (?, ?)", (new_id, name))
            conn.execute("INSERT INTO logs (id, action, actor_name, created_at, details) VALUES (?, ?, ?, ?, ?)",
                (f"l_{int(datetime.now().timestamp())}", "person.create", "Omar", datetime.now().isoformat(), json.dumps({"name": name})))
            conn.commit()
            return jsonify({"id": new_id, "name": name})
        people = conn.execute("SELECT id, name FROM people").fetchall()
        return jsonify([dict(p) for p in people])

@app.route("/api/people/<person_id>", methods=["DELETE"])
def delete_person(person_id):
    with get_db() as conn:
        conn.execute("DELETE FROM people WHERE id = ?", (person_id,))
        conn.commit()
    return jsonify({"success": True})

@app.route("/api/people/<person_id>/reset-password", methods=["POST"])
def reset_password(person_id):
    return jsonify({"success": True})

@app.route("/api/me/password", methods=["PATCH"])
def change_my_password():
    return jsonify({"success": True})

@app.route("/api/bills", methods=["GET"])
def get_bills():
    month = request.args.get("month")
    with get_db() as conn:
        query = "SELECT * FROM bills" + (" WHERE month = ?" if month else "") + " ORDER BY created_at DESC"
        bills_rows = conn.execute(query, ([month] if month else [])).fetchall()
        bills = []
        for b in bills_rows:
            bd = dict(b)
            items_rows = conn.execute("SELECT * FROM items WHERE bill_id = ?", (bd["id"],)).fetchall()
            items = []
            for item in items_rows:
                idict = dict(item)
                idict["assignee_ids"] = json.loads(idict["assignee_ids"]) if idict["assignee_ids"] else []
                idict["needs_review"] = bool(idict["needs_review"])
                items.append(idict)
            bd["items"] = items
            bills.append(bd)
        return jsonify(bills)

@app.route("/api/bills/manual", methods=["POST"])
def add_manual_bill():
    data = request.json or {}
    payer_id = data.get("payer_id")
    month = data.get("month", "2026-08")
    raw_items = data.get("items", [])
    bill_id = f"b_{int(datetime.now().timestamp())}"
    now_iso = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute("INSERT INTO bills (id, payer_id, uploaded_by_id, month, created_at, image_path) VALUES (?, ?, ?, ?, ?, ?)",
            (bill_id, payer_id, "p1", month, now_iso, None))
        new_items = []
        for idx, item in enumerate(raw_items):
            item_id = f"i_{int(datetime.now().timestamp())}_{idx}"
            conn.execute("INSERT INTO items (id, bill_id, name, price, assignee_ids, needs_review, translation) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (item_id, bill_id, item["name"], float(item["price"]), json.dumps(item.get("assignee_ids", [])), 0, None))
            new_items.append({"id": item_id, "bill_id": bill_id, "name": item["name"], "price": float(item["price"]), "assignee_ids": item.get("assignee_ids", []), "needs_review": False, "translation": None})
        pn = conn.execute("SELECT name FROM people WHERE id = ?", (payer_id,)).fetchone()
        conn.execute("INSERT INTO logs (id, action, actor_name, created_at, details) VALUES (?, ?, ?, ?, ?)",
            (f"l_{int(datetime.now().timestamp())}", "bill.manual_add", pn["name"] if pn else "Someone", now_iso, json.dumps({"item_count": len(new_items)})))
        conn.commit()
    return jsonify({"id": bill_id, "payer_id": payer_id, "uploaded_by_id": "p1", "month": month, "created_at": now_iso, "image_path": None, "items": new_items})

@app.route("/api/bills/upload", methods=["POST"])
def upload_bill():
    payer_id = request.form.get("payer_id")
    month = request.form.get("month", "2026-08")
    file = request.files.get("file")
    img_rel_path = None
    extracted_items = []
    if file:
        os.makedirs("uploads", exist_ok=True)
        save_name = f"{int(datetime.now().timestamp())}_{file.filename}"
        file_bytes = file.read()
        with open(os.path.join("uploads", save_name), "wb") as f:
            f.write(file_bytes)
        img_rel_path = f"/uploads/{save_name}"
        extracted_items = process_receipt_with_ai(file_bytes, file.content_type or "image/jpeg")
    bill_id = f"b_{int(datetime.now().timestamp())}"
    now_iso = datetime.now().isoformat()
    with get_db() as conn:
        conn.execute("INSERT INTO bills (id, payer_id, uploaded_by_id, month, created_at, image_path) VALUES (?, ?, ?, ?, ?, ?)",
            (bill_id, payer_id, "p1", month, now_iso, img_rel_path))
        new_items = []
        for idx, item in enumerate(extracted_items):
            item_id = f"i_{int(datetime.now().timestamp())}_{idx}"
            name = item.get("name", f"Item {idx+1}")
            price = float(item.get("price", 0.00))
            translation = item.get("original_name")
            conn.execute("INSERT INTO items (id, bill_id, name, price, assignee_ids, needs_review, translation) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (item_id, bill_id, name, price, json.dumps([]), 1, translation))
            new_items.append({"id": item_id, "bill_id": bill_id, "name": name, "price": price, "assignee_ids": [], "needs_review": True, "translation": translation})
        pn = conn.execute("SELECT name FROM people WHERE id = ?", (payer_id,)).fetchone()
        conn.execute("INSERT INTO logs (id, action, actor_name, created_at, details, bill_image_path) VALUES (?, ?, ?, ?, ?, ?)",
            (f"l_{int(datetime.now().timestamp())}", "bill.upload", pn["name"] if pn else "Someone", now_iso, json.dumps({"item_count": len(new_items)}), img_rel_path))
        conn.commit()
    return jsonify({"id": bill_id, "payer_id": payer_id, "uploaded_by_id": "p1", "month": month, "created_at": now_iso, "image_path": img_rel_path, "items": new_items})

@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory("uploads", filename)

@app.route("/api/bills/<bill_id>", methods=["DELETE"])
def delete_bill(bill_id):
    with get_db() as conn:
        conn.execute("DELETE FROM items WHERE bill_id = ?", (bill_id,))
        conn.execute("DELETE FROM bills WHERE id = ?", (bill_id,))
        conn.commit()
    return jsonify({"success": True})

@app.route("/api/items/<item_id>", methods=["PATCH"])
def patch_item(item_id):
    data = request.json or {}
    with get_db() as conn:
        item = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if not item:
            return jsonify({"error": "Item not found"}), 404
        idict = dict(item)
        if "name" in data: idict["name"] = data["name"]
        if "price" in data: idict["price"] = float(data["price"])
        if "translation" in data: idict["translation"] = data["translation"]
        if "needs_review" in data: idict["needs_review"] = 1 if data["needs_review"] else 0
        conn.execute("UPDATE items SET name = ?, price = ?, translation = ?, needs_review = ? WHERE id = ?",
            (idict["name"], idict["price"], idict["translation"], idict["needs_review"], item_id))
        conn.commit()
        idict["assignee_ids"] = json.loads(idict["assignee_ids"]) if idict["assignee_ids"] else []
        idict["needs_review"] = bool(idict["needs_review"])
        return jsonify(idict)

@app.route("/api/items/<item_id>/assign", methods=["POST"])
def assign_item(item_id):
    data = request.json or {}
    person_ids = data.get("person_ids", [])
    with get_db() as conn:
        conn.execute("UPDATE items SET assignee_ids = ? WHERE id = ?", (json.dumps(person_ids), item_id))
        conn.commit()
        item = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if item:
            idict = dict(item)
            idict["assignee_ids"] = person_ids
            idict["needs_review"] = bool(idict["needs_review"])
            return jsonify(idict)
    return jsonify({"error": "Item not found"}), 404

@app.route("/api/items/<item_id>", methods=["DELETE"])
def delete_item(item_id):
    with get_db() as conn:
        conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        conn.commit()
    return jsonify({"success": True})

@app.route("/api/settlement", methods=["GET"])
def get_settlement():
    month = request.args.get("month", "2026-08")
    with get_db() as conn:
        people_rows = conn.execute("SELECT id, name FROM people").fetchall()
        all_ids = {p["id"]: p["name"] for p in people_rows}
        bills_rows = conn.execute("SELECT * FROM bills WHERE month = ?", (month,)).fetchall()
        paid_map = {pid: 0.0 for pid in all_ids}
        share_map = {pid: 0.0 for pid in all_ids}
        unassigned_total = 0.0
        for b in bills_rows:
            payer_id = b["payer_id"]
            for item in conn.execute("SELECT * FROM items WHERE bill_id = ?", (b["id"],)).fetchall():
                price = item["price"]
                assignees = json.loads(item["assignee_ids"]) if item["assignee_ids"] else []
                for pid in assignees:
                    if pid.startswith("guest_") and pid not in all_ids:
                        all_ids[pid] = pid.replace("guest_", "") + " (Guest)"
                        paid_map[pid] = 0.0
                        share_map[pid] = 0.0
                if payer_id in paid_map:
                    paid_map[payer_id] += price
                if not assignees:
                    unassigned_total += price
                else:
                    per_person = price / len(assignees)
                    for pid in assignees:
                        if pid in share_map:
                            share_map[pid] += per_person
        balances = [{"person_id": pid, "name": pname, "paid": paid_map.get(pid, 0.0), "owed_share": share_map.get(pid, 0.0), "net": paid_map.get(pid, 0.0) - share_map.get(pid, 0.0)} for pid, pname in all_ids.items()]
        pos_list = [{"name": b["name"], "amount": b["net"]} for b in balances if b["net"] > 0.01]
        neg_list = [{"name": b["name"], "amount": -b["net"]} for b in balances if b["net"] < -0.01]
        transactions = []
        i, j = 0, 0
        while i < len(neg_list) and j < len(pos_list):
            amt = min(neg_list[i]["amount"], pos_list[j]["amount"])
            if amt > 0.01:
                transactions.append({"from_name": neg_list[i]["name"], "to_name": pos_list[j]["name"], "amount": round(amt, 2)})
            neg_list[i]["amount"] -= amt
            pos_list[j]["amount"] -= amt
            if neg_list[i]["amount"] <= 0.01: i += 1
            if pos_list[j]["amount"] <= 0.01: j += 1
        return jsonify({"unassigned_total": unassigned_total, "balances": balances, "transactions": transactions})

@app.route("/api/logs", methods=["GET"])
def get_logs():
    with get_db() as conn:
        logs_rows = conn.execute("SELECT * FROM logs ORDER BY created_at DESC LIMIT 50").fetchall()
        logs = []
        for r in logs_rows:
            d = dict(r)
            d["details"] = json.loads(d["details"]) if d["details"] else {}
            logs.append(d)
        return jsonify(logs)

if __name__ == "__main__":
    print("Hisab server running on http://localhost:8080")
    app.run(host="0.0.0.0", port=8080, debug=False)
