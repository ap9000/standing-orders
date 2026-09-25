# Linux

## Install

The installer works the same as on macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/ap9000/standing-orders/main/install.sh | sh
```

It needs Node.js 22.13 or newer (from nodejs.org, your package manager, or
`fnm install 22`) and git. If npm says permission denied, give it a folder
you own: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally

## Install bubblewrap

```sh
sudo apt install bubblewrap      # Debian, Ubuntu
sudo dnf install bubblewrap      # Fedora
```

With it, Claude and Gemini agents run in a sandbox where Standing Orders'
own secrets don't exist. See [Security](security.md).

## Keep it running

`standing-orders up` runs until you stop it. To keep it running after you log
out, run it as a user service. Save this as
`~/.config/systemd/user/standing-orders.service`:

```ini
[Unit]
Description=Standing Orders

[Service]
ExecStart=/usr/bin/env standing-orders up --project-root %h/Projects --no-open
Restart=on-failure

[Install]
WantedBy=default.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now standing-orders
loginctl enable-linger "$USER"     # keep it running when you're logged out
journalctl --user -u standing-orders -f   # what it's doing
```

If `standing-orders` isn't on the service's PATH, use the full path from
`command -v standing-orders` in `ExecStart`.

## Reaching it from elsewhere

On a server, put it on your tailnet: `standing-orders up --host 0.0.0.0
--allow-host <machine>.ts.net:4180`, and open `http://<machine>.ts.net:4180`
from your laptop or phone.
