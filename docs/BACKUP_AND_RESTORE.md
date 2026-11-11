# DeployKit — Backup & Disaster Recovery Guide

DeployKit includes non-destructive database backup and recovery scripts in `ops/backup/`. DeployKit database backups use PostgreSQL's custom archive format (`pg_dump -Fc`), which supports compression, integrity verification, and selective restore.

---

## 1. Creating a Database Backup

Run the automated backup script from the repository root:

```bash
./ops/backup/backup-db.sh [output-dir]
```

- **Default output directory**: `./backups/`
- **Output filename format**: `deploykit-YYYYMMDDTHHMMSSZ.dump`

### Example:
```bash
./ops/backup/backup-db.sh /var/backups/deploykit
```

### Safety Guarantees:
- **Non-destructive & Non-blocking**: `pg_dump` takes a consistent MVCC snapshot of the database without locking tables or interrupting active deployments.
- **Integrity Validation**: The script checks that the backup file is non-empty and verifies the PostgreSQL custom archive magic byte header (`PGDMP`).

---

## 2. Restoring a Backup (Verification Mode)

By default, the restore script restores the backup archive into a **new, isolated database** so that active production data is never disturbed:

```bash
./ops/backup/restore-db.sh backups/deploykit-20261111T180000Z.dump
```

- Creates a timestamped verification database: `deploykit_restored_<timestamp>`.
- Restores the entire schema, tables, and records into this verification database.
- Allows you to inspect and verify data integrity safely before making any changes to production.

---

## 3. Restoring into the Live Database (Disaster Recovery)

> [!CAUTION]
> Restoring with `--force-live` will drop and recreate the active `deploykit` database. This is destructive and cannot be undone.

To perform a complete disaster recovery of the live database:

```bash
./ops/backup/restore-db.sh backups/deploykit-20261111T180000Z.dump deploykit --force-live
```

---

## 4. Setting up Automated Scheduled Backups (Cron)

To take daily automated backups at 02:00 AM and retain them for 30 days, add the following cron entry:

```bash
# Edit crontab
crontab -e
```

```cron
# Daily DeployKit database backup at 2:00 AM UTC
0 2 * * * /opt/deploykit/ops/backup/backup-db.sh /var/backups/deploykit >> /var/log/deploykit-backup.log 2>&1

# Prune backups older than 30 days
0 3 * * * find /var/backups/deploykit -type f -name "deploykit-*.dump" -mtime +30 -delete
```
