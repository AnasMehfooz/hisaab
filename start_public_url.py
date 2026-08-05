"""
Start pyngrok tunnel to make Hisab live on the internet
"""
from pyngrok import ngrok
import time

public_url = ngrok.connect(8080)
print("==========================================")
print(f" 🌐 YOUR HISAB WEBSITE IS LIVE ONLINE AT: ")
print(f" 👉 {public_url} ")
print("==========================================")

# Keep alive
while True:
    time.sleep(10)
