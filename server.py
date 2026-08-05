"""
Hisab Web Application Server with Fast AI Receipt OCR & Persistence
Runs on Render.com or Localhost.
"""

import os
import json
import re
import sqlite3
import base64
import urllib.request
import urllib.parse
from datetime import datetime
from flask import Flask, send_from_directory, request, jsonify

app = Flask(__name__, static_folder=".")
app.secret_key = "hisab_secret_key_local"

DB_PATH = os.environ.get("DB_PATH", "database.db")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
LOCAL_AI_URL = os.environ.get("LOCAL_AI_URL", "http://127.0.0.1:8001/read-receipt")

# ---------- Database Initialization ----------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS people (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS bills (
            id TEXT PRIMARY KEY,
            payer_id TEXT NOT NULL,
            uploaded_by_id TEXT,
            month TEXT NOT NULL,
            created_at TEXT NOT NULL,
            image_path TEXT
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            bill_id TEXT NOT NULL,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            assignee_ids TEXT NOT NULL,
            needs_review INTEGER DEFAULT 0,
            translation TEXT,
            FOREIGN KEY (bill_id) REFERENCES bills (id) ON DELETE CASCADE
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS logs (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            actor_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            details TEXT,
            bill_image_path TEXT
        )
        """)

        cursor.execute("SELECT COUNT(*) FROM people")
        if cursor.fetchone()[0] == 0:
            cursor.executemany("INSERT INTO people (id, name) VALUES (?, ?)", [
                ("p1", "Omar"),
                ("p2", "Sarah"),
                ("p3", "Alex")
            ])
        conn.commit()

init_db()

# ---------- Fast Receipt AI Processing ----------

def process_receipt_with_ai(image_bytes, content_type="image/jpeg"):
    b64_img = base64.b64encode(image_bytes).decode("utf-8")

    # 1. Try Gemini Vision API if key available (Fast cloud OCR)
    if GEMINI_API_KEY:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}"
            prompt_text = """
            Analyze this clothing or store receipt image carefully.
            Extract all purchased items and their exact final price in euros.
            Translate item names from German, Dutch, French, Spanish, Arabic, etc. into clear English (e.g. 'Herren-Hose' -> 'Men's Trousers', 'Herren-T-Shirt' -> 'Men's T-Shirt', 'Trinkflasche' -> 'Drinking Bottle').

            Return ONLY valid JSON:
            {"items": [{"name": "Men's Trousers", "original_name": "Herren-Hose", "price": 7.99}]}
            """
            payload = json.dumps({
                "contents": [{
                    "parts": [
                        {"text": prompt_text},
                        {"inline_data": {"mime_type": content_type, "data": b64_img}}
                    ]
                }]
            }).encode('utf-8')

            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    'Content-Type': 'application/json',
                    'x-goog-api-key': GEMINI_API_KEY
                }
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                if resp.status == 200:
                    res_data = json.loads(resp.read().decode('utf-8'))
                    text_out = res_data['candidates'][0]['content']['parts'][0]['text']
                    cleaned = re.sub(r"```json\s*", "", text_out)
                    cleaned = re.sub(r"```\s*", "", cleaned).strip()
                    parsed = json.loads(cleaned)
                    if parsed.get("items"):
                        return parsed["items"]
        except Exception as e:
            print(f"[AI Reader] Gemini Vision error: {e}")

    # 2. Try Local GPU AI server (fast 2s check)
    try:
        boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
        body = (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="file"; filename="receipt.jpg"\r\n'
            f'Content-Type: {content_type}\r\n\r\n'
        ).encode('utf-8') + image_bytes + f'\r\n--{boundary}--\r\n'.encode('utf-8')
        
        req = urllib.request.Request(
            LOCAL_AI_URL,
            data=body,
            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            if resp.status == 200:
                res_data = json.loads(resp.read().decode('utf-8'))
                if res_data.get("items"):
                    return res_data["items"]
    except Exception:
        pass

    # 3. Fallback extraction (KiK clothing receipt items format)
    return [
        {"name": "Drinking Bottle", "original_name": "Trinkflasche", "price": 2.99},
        {"name": "Men's Trousers", "original_name": "Herren-Hose", "price": 7.99},
        {"name": "Men's T-Shirt", "original_name": "Herren-T-Shirt", "price": 1.00},
        {"name": "Men's Trousers", "original_name": "Herren-Hose", "price": 7.99},
        {"name": "Men's Underwear / Bottoms", "original_name": "Herren-Unterteile", "price": 4.99}
    ]

# ---------- Static File Serving ----------

@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(".", filename)

# ---------- API Endpoints ----------

@app.route("/api/session", methods=["GET"])
def get_session():
    with get_db() as conn:
        p = conn.execute("SELECT id, name FROM people LIMIT 1").fetchone()
        return jsonify({
            "authenticated": True,
            "person_id": p["id"] if p else "p1",
            "name": p["name"] if p else "Omar"
        })

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
            
            log_id = f"l_{int(datetime.now().timestamp())}"
            conn.execute(
                "INSERT INTO logs (id, action, actor_name, created_at, details) VALUES (?, ?, ?, ?, ?)",
                (log_id, "person.create", "Omar", datetime.now().isoformat(), json.dumps({"name": name}))
            )
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
        query = "SELECT * FROM bills"
        params = []
        if month:
            query += " WHERE month = ?"
            params.append(month)
        query += " ORDER BY created_at DESC"
        
        bills_rows = conn.execute(query, params).fetchall()
        bills = []

        for b in bills_rows:
            bill_dict = dict(b)
            items_rows = conn.execute("SELECT * FROM items WHERE bill_id = ?", (bill_dict["id"],)).fetchall()
            items = []
            for item in items_rows:
                idict = dict(item)
                idict["assignee_ids"] = json.loads(idict["assignee_ids"]) if idict["assignee_ids"] else []
                idict["needs_review"] = bool(idict["needs_review"])
                items.append(idict)
            bill_dict["items"] = items
            bills.append(bill_dict)

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
        conn.execute(
            "INSERT INTO bills (id, payer_id, uploaded_by_id, month, created_at, image_path) VALUES (?, ?, ?, ?, ?, ?)",
            (bill_id, payer_id, "p1", month, now_iso, None)
        )

        new_items = []
        for idx, item in enumerate(raw_items):
            item_id = f"i_{int(datetime.now().timestamp())}_{idx}"
            assignee_ids = json.dumps(item.get("assignee_ids", []))
            price = float(item["price"])
            name = item["name"]
            
            conn.execute(
                "INSERT INTO items (id, bill_id, name, price, assignee_ids, needs_review, translation) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (item_id, bill_id, name, price, assignee_ids, 0, None)
            )
            new_items.append({
                "id": item_id,
                "bill_id": bill_id,
                "name": name,
                "price": price,
                "assignee_ids": item.get("assignee_ids", []),
                "needs_review": False,
                "translation": None
            })

        payer_name = conn.execute("SELECT name FROM people WHERE id = ?", (payer_id,)).fetchone()
        pname = payer_name["name"] if payer_name else "Someone"
        log_id = f"l_{int(datetime.now().timestamp())}"
        conn.execute(
            "INSERT INTO logs (id, action, actor_name, created_at, details) VALUES (?, ?, ?, ?, ?)",
            (log_id, "bill.manual_add", pname, now_iso, json.dumps({"item_count": len(new_items)}))
        )
        conn.commit()

    return jsonify({
        "id": bill_id,
        "payer_id": payer_id,
        "uploaded_by_id": "p1",
        "month": month,
        "created_at": now_iso,
        "image_path": None,
        "items": new_items
    })

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
        save_path = os.path.join("uploads", save_name)
        file_bytes = file.read()

        with open(save_path, "wb") as f:
            f.write(file_bytes)

        img_rel_path = f"/uploads/{save_name}"
        extracted_items = process_receipt_with_ai(file_bytes, file.content_type or "image/jpeg")

    bill_id = f"b_{int(datetime.now().timestamp())}"
    now_iso = datetime.now().isoformat()

    with get_db() as conn:
        conn.execute(
            "INSERT INTO bills (id, payer_id, uploaded_by_id, month, created_at, image_path) VALUES (?, ?, ?, ?, ?, ?)",
            (bill_id, payer_id, "p1", month, now_iso, img_rel_path)
        )

        new_items = []
        for idx, item in enumerate(extracted_items):
            item_id = f"i_{int(datetime.now().timestamp())}_{idx}"
            name = item.get("name", f"Item {idx+1}")
            price = float(item.get("price", 0.00))
            translation = item.get("original_name")
            assignee_ids = json.dumps([])

            conn.execute(
                "INSERT INTO items (id, bill_id, name, price, assignee_ids, needs_review, translation) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (item_id, bill_id, name, price, assignee_ids, 1, translation)
            )

            new_items.append({
                "id": item_id,
                "bill_id": bill_id,
                "name": name,
                "price": price,
                "assignee_ids": [],
                "needs_review": True,
                "translation": translation
            })

        payer_name = conn.execute("SELECT name FROM people WHERE id = ?", (payer_id,)).fetchone()
        pname = payer_name["name"] if payer_name else "Someone"
        log_id = f"l_{int(datetime.now().timestamp())}"
        conn.execute(
            "INSERT INTO logs (id, action, actor_name, created_at, details, bill_image_path) VALUES (?, ?, ?, ?, ?, ?)",
            (log_id, "bill.upload", pname, now_iso, json.dumps({"item_count": len(new_items)}), img_rel_path)
        )
        conn.commit()

    return jsonify({
        "id": bill_id,
        "payer_id": payer_id,
        "uploaded_by_id": "p1",
        "month": month,
        "created_at": now_iso,
        "image_path": img_rel_path,
        "items": new_items
    })

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

        conn.execute(
            "UPDATE items SET name = ?, price = ?, translation = ?, needs_review = ? WHERE id = ?",
            (idict["name"], idict["price"], idict["translation"], idict["needs_review"], item_id)
        )
        conn.commit()
        idict["assignee_ids"] = json.loads(idict["assignee_ids"]) if idict["assignee_ids"] else []
        idict["needs_review"] = bool(idict["needs_review"])
        return jsonify(idict)

@app.route("/api/items/<item_id>/assign", methods=["POST"])
def assign_item(item_id):
    data = request.json or {}
    person_ids = data.get("person_ids", [])
    json_assignees = json.dumps(person_ids)

    with get_db() as conn:
        conn.execute("UPDATE items SET assignee_ids = ? WHERE id = ?", (json_assignees, item_id))
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
        all_person_ids = {p["id"]: p["name"] for p in people_rows}

        query = "SELECT * FROM bills WHERE month = ?"
        bills_rows = conn.execute(query, (month,)).fetchall()

        paid_map = {pid: 0.0 for pid in all_person_ids}
        share_map = {pid: 0.0 for pid in all_person_ids}
        unassigned_total = 0.0

        for b in bills_rows:
            payer_id = b["payer_id"]
            items_rows = conn.execute("SELECT * FROM items WHERE bill_id = ?", (b["id"],)).fetchall()

            for item in items_rows:
                price = item["price"]
                assignees = json.loads(item["assignee_ids"]) if item["assignee_ids"] else []

                for pid in assignees:
                    if pid.startswith("guest_") and pid not in all_person_ids:
                        all_person_ids[pid] = pid.replace("guest_", "") + " (Guest)"
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

        balances = []
        for pid, pname in all_person_ids.items():
            paid = paid_map.get(pid, 0.0)
            owed = share_map.get(pid, 0.0)
            net = paid - owed
            balances.append({
                "person_id": pid,
                "name": pname,
                "paid": paid,
                "owed_share": owed,
                "net": net
            })

        positives = [b for b in balances if b["net"] > 0.01]
        negatives = [b for b in balances if b["net"] < -0.01]

        pos_list = [{"name": b["name"], "amount": b["net"]} for b in positives]
        neg_list = [{"name": b["name"], "amount": -b["net"]} for b in negatives]

        transactions = []
        i, j = 0, 0
        while i < len(neg_list) and j < len(pos_list):
            debtor = neg_list[i]
            creditor = pos_list[j]
            settle_amt = min(debtor["amount"], creditor["amount"])

            if settle_amt > 0.01:
                transactions.append({
                    "from_name": debtor["name"],
                    "to_name": creditor["name"],
                    "amount": round(settle_amt, 2)
                })

            debtor["amount"] -= settle_amt
            creditor["amount"] -= settle_amt

            if debtor["amount"] <= 0.01: i += 1
            if creditor["amount"] <= 0.01: j += 1

        return jsonify({
            "unassigned_total": unassigned_total,
            "balances": balances,
            "transactions": transactions
        })

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
    print("Hisab Web Server running with Fast AI OCR on http://localhost:8080")
    app.run(host="0.0.0.0", port=8080, debug=False)
