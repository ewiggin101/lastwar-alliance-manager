# Rebuilding the Oracle deployment from backups

Three things exist off-box, and together they are the whole deployment:

| What | Where | Made by |
|---|---|---|
| Config bundle `lwm-system.tgz` | NAS `rsync-backups/oracle/lwm/backups/` | `deploy/lwm-backup.sh` step 2, every 6h |
| DB snapshots `alliance_<ts>.db` | NAS, same dir (30 days) | step 1 |
| DB as SQL text, full history | GitHub `ewiggin101/lwm-data` (private) | step 3 |
| Secrets | Proton Pass | you |

The bundle is deliberately **not** a full disk image and carries **no secrets**.
It holds the compose files, Caddyfile, systemd units, NAS-push config and an
`env-manifest.txt` listing every env variable by name. Refilling those from
Proton Pass is the one manual step.

## Restore

```bash
# 1. Docker + sqlite3 on a fresh Ubuntu box, then:
tar -xzf lwm-system.tgz                                   # -> ./lwm-system/{home,etc,opt,usr}, mirrors original paths
cat lwm-system/env-manifest.txt                           # what to refill
sudo cp -a lwm-system/home lwm-system/etc lwm-system/opt lwm-system/usr /

# 2. Secrets -- pipe from pass-cli on nuc2 over ssh stdin; never paste, never scp a file
#    /home/ubuntu/lastwar-alliance-manager/.env
#      SESSION_KEY              Proton Pass: Infrastructure vault (verify item name)  -- or regenerate: openssl rand -hex 32 (logs everyone out, nothing else)
#      LASTWAR_FARM_API_KEY     APIs vault, item farmops-lastwar-puc, field "API Key"
#      LASTWAR_FARM_WRITE_KEY   APIs vault (verify item name -- the write-scoped FarmOps key)
#    /opt/bots/discord-scout-bot1.env
#      DISCORD_TOKEN            APIs vault, item "discord-scout-bot1 - Discord Token", field "API Key"
#      LWM_USERNAME/PASSWORD    Infrastructure vault, item lwm-svc-scoutbot
#      ANTHROPIC_API_KEY        APIs vault, item "discord-scout-bot1 - Anthropic API Key", field "API Key"
#    /opt/bots/discord-translate-bot{1,2}.env   see the discord-bot repo
#    /etc/nas-backup.pass                        NAS rsync account "oraclebackup"

# 3. Data: newest snapshot from the NAS, or rebuild from the SQL history
mkdir -p /home/ubuntu/lastwar-alliance-manager/data
sudo cp alliance_<ts>.db /home/ubuntu/lastwar-alliance-manager/data/alliance.db
#   -- or --
git clone git@github.com:ewiggin101/lwm-data.git && sqlite3 data/alliance.db < lwm-data/alliance.sql

# 4. Up
cd /home/ubuntu/lastwar-alliance-manager && docker compose pull && docker compose up -d
cd /opt/bots && docker compose up -d                       # scout bot image is built on-box: see discord-lwm-relay README
sudo systemctl daemon-reload && sudo systemctl enable --now lwm-backup.timer nas-backup.timer
```

## The GitHub side (`lwm-data`)

Oracle pushes with a **write-only deploy key** scoped to that one repo
(`/home/ubuntu/.ssh/lwm-data_deploy`; clone at `/home/ubuntu/lwm-data`,
`core.sshCommand` pinned to that key). It can push to `lwm-data` and nothing
else. To rotate: `ssh-keygen -t ed25519 -N '' -f ~/.ssh/lwm-data_deploy` as
`ubuntu`, then `gh repo deploy-key add --allow-write --repo ewiggin101/lwm-data
<pub>` from nuc2 and delete the old key in the repo's settings.

Every commit is one `sqlite3 .dump`, so `git log -p alliance.sql` is a
change-by-change history of members, VS points and storm results. The repo
is private; it holds alliance member data and the `users` table (bcrypt
password hashes for the LWM logins -- a restore needs them). The one table
whose rows are left out is `login_sessions`, the login audit log (IPs,
browsers, geo): it has no restore value and is the most personal thing in
the database. Its schema is kept so the dump restores cleanly.
