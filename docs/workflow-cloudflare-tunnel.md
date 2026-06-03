# Workflow Cloudflare Tunnel Notes

## Purpose
- Factory-side users cannot access the office ERP server directly.
- Expose only the ERP HTTP service through Cloudflare Tunnel when the server PC is online.
- Keep file storage paths based on the server PC, not the local developer PC.

## Server-Only Values To Confirm
- ERP server root: `D:\price-list-app`
- Main app URL: `http://127.0.0.1:3000` on the server PC
- Workflow file storage root: confirm on server before hardcoding or migrating
- Tunnel hostname: decide after Cloudflare account/domain check

## Intended Workflow Behavior
- Design uploads proof images/JPG and AI originals in ERP.
- Design sets the requested completion date per proof file.
- Factory receives ERP workflow notifications through the tunneled ERP URL.
- Factory replies with available production date and reason per proof file.
- All comments stay attached to the proof/file card.

## Do Not Do
- Do not use local PC paths as workflow file storage rules.
- Do not expose local development server through the tunnel.
- Do not store tunnel tokens in this repository.
