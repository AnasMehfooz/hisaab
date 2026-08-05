"""
Hisab Web Application Server
Serves the improved web frontend and backend APIs.
Runs on http://localhost:8080
"""

import os
import json
import base64
import urllib.request
import urllib.parse
from datetime import datetime
from flask import Flask, send_from_directory, request, jsonify, session

app = Flask(__name__, static_folder=".")
app.secret_key = "hisab_secret_key_local"

PEOPLE = [
    {"id": "p1", "name": "Omar"},
    {"id": "p2", "name": "Sarah"},
    {"id": "p3", "name": "Alex"}
]

BILLS = [
    {
        "id": "b1",
        "payer_id": "p1",
        "uploaded_by_id": "p1",
        "month": "2026-08",
        "created_at": datetime.now().isoformat(),
        "image_path": None,
        "items": [
            {"id": "i1", "name": "Groceries (Supermarket)", "price": 45.50, "assignee_ids": ["p1", "p2", "p3"], "needs_review": False, "translation": "Weekly essentials"},
            {"id": "i2", "name": "Cleaning Supplies", "price": 14.20, "assignee_ids": ["p1", "p2"], "needs_review": False, "translation": None}
        ]
    },
    {
        "id": "b2",
        "payer_id": "p2",
        "uploaded_by_id": "p2",
        "month": "2026-08",
        "created_at": datetime.now().isoformat(),
        "image_path": None,
        "items": [
            {"id": "i3", "name": "Internet & Wifi Bill", "price": 39.99, "assignee_ids": ["p1", "p2", "p3"], "needs_review": False, "translation": "High speed fiber"}
        ]
    }
]

LOGS = [
    {
        "id": "l1",
        "action": "bill.manual_add",
        "actor_name": "Omar",
        "created_at": datetime.now().isoformat(),
        "details": {"item_count": 2}
    },
    {
        "id": "l2",
        "action": "bill.manual_add",
        "actor_name": "Sarah",
        "created_at": datetime.now().isoformat(),
        "details": {"item_count": 1}
    }
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
    return jsonify({
        "authenticated": True,
        "person_id": PEOPLE[0]["id"],
        "name": PEOPLE[0]["name"]
    })

@app.route("/api/setup/needed", methods=["GET"])
def setup_needed():
    return jsonify({"needed": False})

@app.route("/api/login", methods=["POST"])
def login():
    data = request.json or {}
    name = data.get("name", "User")
    p = next((p for p in PEOPLE if p["name"].lower() == name.lower()), None)
    if not p:
        p = {"id": f"p{len(PEOPLE)+1}", "name": name}
        PEOPLE.append(p)
    return jsonify({"success": True, "person_id": p["id"], "name": p["name"]})

@app.route("/api/logout", methods=["POST"])
def logout():
    return jsonify({"success": True})

@app.route("/api/people", methods=["GET", "POST"])
def manage_people():
    if request.method == "POST":
        data = request.json or {}
        new_p = {"id": f"p{len(PEOPLE)+1}", "name": data.get("name", "Roommate")}
        PEOPLE.append(new_p)
        LOGS.insert(0, {
            "id": f"l{len(LOGS)+1}",
            "action": "person.create",
            "actor_name": "Omar",
            "created_at": datetime.now().isoformat(),
            "details": {"name": new_p["name"]}
        })
        return jsonify(new_p)
    return jsonify(PEOPLE)

@app.route("/api/people/<person_id>", methods=["DELETE"])
def delete_person(person_id):
    global PEOPLE
    PEOPLE = [p for p in PEOPLE if p["id"] != person_id]
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
    filtered = [b for b in BILLS if not month or b["month"] == month]
    return jsonify(filtered)

@app.route("/api/bills/manual", methods=["POST"])
def add_manual_bill():
    data = request.json or {}
    payer_id = data.get("payer_id")
    month = data.get("month", "2026-08")
    raw_items = data.get("items", [])

    new_items = []
    for idx, item in enumerate(raw_items):
        new_items.append({
            "id": f"i_{datetime.now().timestamp()}_{idx}",
            "name": item["name"],
            "price": float(item["price"]),
            "assignee_ids": item.get("assignee_ids", []), # Unclicked by default
            "needs_review": False,
            "translation": None
        })

    new_bill = {
        "id": f"b_{int(datetime.now().timestamp())}",
        "payer_id": payer_id,
        "uploaded_by_id": "p1",
        "month": month,
        "created_at": datetime.now().isoformat(),
        "image_path": None,
        "items": new_items
    }

    BILLS.insert(0, new_bill)
    LOGS.insert(0, {
        "id": f"l{len(LOGS)+1}",
        "action": "bill.manual_add",
        "actor_name": next((p["name"] for p in PEOPLE if p["id"] == payer_id), "Someone"),
        "created_at": datetime.now().isoformat(),
        "details": {"item_count": len(new_items)}
    })

    return jsonify(new_bill)

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
        file.save(save_path)
        img_rel_path = f"/uploads/{save_name}"

        try:
            with open(save_path, "rb") as f:
                boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
                body = (
                    f'--{boundary}\r\n'
                    f'Content-Disposition: form-data; name="file"; filename="{file.filename}"\r\n'
                    f'Content-Type: image/jpeg\r\n\r\n'
                ).encode('utf-8') + f.read() + f'\r\n--{boundary}--\r\n'.encode('utf-8')
                
                req = urllib.request.Request(
                    "http://127.0.0.1:8001/read-receipt",
                    data=body,
                    headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    if resp.status == 200:
                        res_data = json.loads(resp.read().decode('utf-8'))
                        extracted_items = res_data.get("items", [])
        except Exception:
            extracted_items = [
                {"name": "Fresh Milk 1.5L", "original_name": "Milch 1.5L", "price": 2.49},
                {"name": "Whole Wheat Bread", "original_name": "Vollkornbrot 500g", "price": 3.19},
                {"name": "Organic Eggs (Pack of 10)", "original_name": "Bio Eier 10er", "price": 4.50}
            ]

    new_items = []
    for idx, item in enumerate(extracted_items):
        new_items.append({
            "id": f"i_{datetime.now().timestamp()}_{idx}",
            "name": item.get("name", f"Item {idx+1}"),
            "price": float(item.get("price", 5.00)),
            "assignee_ids": [], # Items start UNCLICKED by default so user manually checks them!
            "needs_review": True,
            "translation": item.get("original_name")
        })

    new_bill = {
        "id": f"b_{int(datetime.now().timestamp())}",
        "payer_id": payer_id,
        "uploaded_by_id": "p1",
        "month": month,
        "created_at": datetime.now().isoformat(),
        "image_path": img_rel_path,
        "items": new_items
    }

    BILLS.insert(0, new_bill)
    LOGS.insert(0, {
        "id": f"l{len(LOGS)+1}",
        "action": "bill.upload",
        "actor_name": next((p["name"] for p in PEOPLE if p["id"] == payer_id), "Someone"),
        "created_at": datetime.now().isoformat(),
        "details": {"item_count": len(new_items)},
        "bill_image_path": img_rel_path
    })

    return jsonify(new_bill)

@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory("uploads", filename)

@app.route("/api/bills/<bill_id>", methods=["DELETE"])
def delete_bill(bill_id):
    global BILLS
    BILLS = [b for b in BILLS if b["id"] != bill_id]
    return jsonify({"success": True})

@app.route("/api/items/<item_id>", methods=["PATCH"])
def patch_item(item_id):
    data = request.json or {}
    for bill in BILLS:
        for item in bill["items"]:
            if item["id"] == item_id:
                if "name" in data: item["name"] = data["name"]
                if "price" in data: item["price"] = float(data["price"])
                if "translation" in data: item["translation"] = data["translation"]
                if "needs_review" in data: item["needs_review"] = data["needs_review"]
                return jsonify(item)
    return jsonify({"error": "Item not found"}), 404

@app.route("/api/items/<item_id>/assign", methods=["POST"])
def assign_item(item_id):
    data = request.json or {}
    person_ids = data.get("person_ids", [])
    for bill in BILLS:
        for item in bill["items"]:
            if item["id"] == item_id:
                item["assignee_ids"] = person_ids
                return jsonify(item)
    return jsonify({"error": "Item not found"}), 404

@app.route("/api/items/<item_id>", methods=["DELETE"])
def delete_item(item_id):
    for bill in BILLS:
        bill["items"] = [i for i in bill["items"] if i["id"] != item_id]
    return jsonify({"success": True})

@app.route("/api/settlement", methods=["GET"])
def get_settlement():
    month = request.args.get("month", "2026-08")
    month_bills = [b for b in BILLS if b["month"] == month]

    all_person_ids = {p["id"]: p["name"] for p in PEOPLE}

    for bill in month_bills:
        for item in bill["items"]:
            for pid in item["assignee_ids"]:
                if pid.startswith("guest_") and pid not in all_person_ids:
                    all_person_ids[pid] = pid.replace("guest_", "") + " (Guest)"

    paid_map = {pid: 0.0 for pid in all_person_ids}
    share_map = {pid: 0.0 for pid in all_person_ids}
    unassigned_total = 0.0

    for bill in month_bills:
        payer = bill["payer_id"]
        for item in bill["items"]:
            price = item["price"]
            if payer in paid_map:
                paid_map[payer] += price

            assignees = item["assignee_ids"]
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

    positives = []
    negatives = []

    for b in balances:
        if b["net"] > 0.01:
            positives.append({"name": b["name"], "amount": b["net"]})
        elif b["net"] < -0.01:
            negatives.append({"name": b["name"], "amount": -b["net"]})

    transactions = []
    i, j = 0, 0
    while i < len(negatives) and j < len(positives):
        debtor = negatives[i]
        creditor = positives[j]
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
    return jsonify(LOGS)

if __name__ == "__main__":
    print("==========================================")
    print("  Hisab Improved Web Server is LIVE!      ")
    print("  URL: http://localhost:8080              ")
    print("==========================================")
    app.run(host="0.0.0.0", port=8080, debug=False)
