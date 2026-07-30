# Official Chrome Web Store & Automated CI/CD Deployment Guide

This guide details how to publish **Butchr** as an official Chrome Extension and automate deployment on pushes to `main`.

---

## 📋 Step 1: Initial Chrome Web Store Registration

1. **Developer Account:**
   - Sign up for a [Chrome Web Store Developer Account](https://chrome.google.com/webstore/devconsole/) ($5 one-time fee).
2. **First Manual Upload:**
   - Zip the `extension/` directory.
   - Click **Add new item** in the developer console and upload `butchr-extension.zip`.
   - Complete store metadata (description, icons, privacy policy, category).
   - Once submitted and approved, Chrome Web Store assigns a **permanent Extension ID** (e.g. `abcdefghijklmnopqrstuvwxyzabcdef`).

---

## 🔒 Step 2: Bind Native Messaging Host to Extension ID

Once you have your official Extension ID:
1. Update `daemon/scripts/install-native-host.sh` with your official Extension ID:
   ```json
   "allowed_origins": [
     "chrome-extension://<YOUR_OFFICIAL_EXTENSION_ID>/"
   ]
   ```
2. Re-run `install-native-host.sh` to update local manifests.

---

## 🔑 Step 3: Configure Chrome Web Store API Credentials

To allow GitHub Actions to auto-publish updates:

1. **Enable API in Google Cloud:**
   - Open [Google Cloud Console](https://console.cloud.google.com/).
   - Create a project and enable the **Chrome Web Store API**.
2. **OAuth 2.0 Credentials:**
   - Create OAuth 2.0 credentials (Desktop Application).
   - Generate a `REFRESH_TOKEN` using `client_id` and `client_secret` via OAuth 2.0 Playground (`https://www.googleapis.com/auth/chromewebstore`).
3. **Set GitHub Repository Secrets:**
   In GitHub repository settings (`Settings -> Secrets and variables -> Actions`), add:
   - `CHROME_EXTENSION_ID`: Your Chrome Web Store Item ID
   - `CHROME_CLIENT_ID`: OAuth Client ID
   - `CHROME_CLIENT_SECRET`: OAuth Client Secret
   - `CHROME_REFRESH_TOKEN`: Generated Refresh Token

---

## 🚀 Step 4: Automated CI/CD Pipeline

The `.github/workflows/deploy-extension.yml` workflow automatically:
- Triggers on push to `main` when `extension/**` files change.
- Zips the extension directory into `dist/butchr-extension.zip`.
- Uploads and publishes the update to the Chrome Web Store API.
- Users receive the extension update automatically within 5-24 hours via Chrome's background updater.
