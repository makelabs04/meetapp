# MeetSpace — Hostinger Deployment Guide

## Prerequisites on Hostinger VPS
- Node.js 18+ installed
- npm installed
- Domain/subdomain pointed to your VPS IP

---

## Step 1: Upload Files

Upload all project files to your VPS via FTP or SSH:
```bash
# Via SCP
scp -r meetapp/ user@your-server-ip:/home/user/meetapp

# Or clone from GitHub if you push it there
git clone https://github.com/youruser/meetapp.git
```

---

## Step 2: Install Dependencies

```bash
cd /home/user/meetapp
npm install
```

---

## Step 3: Install PM2 (Process Manager)

PM2 keeps your app running after server restarts.

```bash
npm install -g pm2
pm2 start server.js --name meetapp
pm2 startup          
pm2 save
```

---

## Step 4: Configure Nginx Reverse Proxy

On Hostinger VPS, install Nginx and configure it:

```bash
sudo apt update && sudo apt install nginx -y
```

Create config at `/etc/nginx/sites-available/meetapp`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/meetapp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## Step 5: Enable HTTPS (Required for Camera/Mic!)

**⚠️ IMPORTANT: Browsers only allow camera/mic access on HTTPS.**

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

---

## Step 6: Open Firewall Ports

```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 3000   # Optional: only if direct access needed
sudo ufw enable
```

---

## Environment Variables (Optional)

Create a `.env` file for custom port:
```
PORT=3000
```

---

## Useful PM2 Commands

```bash
pm2 status          # Check app status
pm2 logs meetapp    # View logs
pm2 restart meetapp # Restart
pm2 stop meetapp    # Stop
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Camera not working | Must use HTTPS (Step 5) |
| App not starting | Check `pm2 logs meetapp` |
| 502 Bad Gateway | App not running, check pm2 status |
| Can't connect peers | Check if WebSocket upgrade is in Nginx config |

---

## Architecture

```
Browser A ──┐
            ├── Socket.io (Signaling) ──> Node.js Server
Browser B ──┘         
    │                                         │
    └──────── WebRTC Direct P2P ──────────────┘
              (video/audio data)
```

The Node.js server only handles **signaling** (offer/answer/ICE exchange).
Actual video/audio data flows **directly peer-to-peer** via WebRTC.
