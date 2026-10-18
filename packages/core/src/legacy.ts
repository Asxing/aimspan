import { constants, closeSync, existsSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { noLinks, privateFile } from "./security.js";

const MAX_ROWS = 100_000;
const MAX_TABLES = 256;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
export const sqlIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Fail explicitly on oversized input; never silently drop legacy rows. */
export function legacyRows(db: DatabaseSync, table: string): Record<string, SQLOutputValue>[] {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
    const rows = db.prepare(`SELECT * FROM ${sqlIdentifier(table)} LIMIT ?`).all(MAX_ROWS + 1);
    if (rows.length > MAX_ROWS) throw new Error("core.errorLegacyImportExceedsTheRowLimitSourceRemainsUntouched");
    return rows;
}

/** Main-selected JSON destination; snapshots include every table, including unknown legacy schemas. */
export function exportLegacyTables(path: string, databases: { name: string; db: DatabaseSync; schema: string }[]) {
    if (!isAbsolute(path) || !path.endsWith(".json") || path.split(/[\\/]/).some(part => part.toLowerCase() === ".codex" || part.toLowerCase() === ".claude"))
        throw new Error("core.errorChooseAJsonFileOutsideNativeAgentDirectories");
    for (const source of databases) {
        if (source.db.prepare("PRAGMA database_list").all().some(row => row.file && resolve(String(row.file)) === resolve(path)))
            throw new Error("core.errorTheExportDestinationIsADatabaseChooseAnotherJsonFile");
    }
    noLinks(dirname(path));
    if (existsSync(path)) privateFile(path);
    const temporary = join(dirname(path), `.aimspan-export-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let bytes = 0, rowCount = 0, tableCount = 0;
    const write = (value: string) => {
        const buffer = Buffer.from(value);
        bytes += buffer.length;
        if (bytes > MAX_EXPORT_BYTES) throw new Error("core.errorLegacyExportExceeds64MibNoPartialExportWasSaved");
        // Regular-file writes can be short; cap attempts even if the OS stops making progress.
        let offset = 0;
        for (let attempt = 0; offset < buffer.length && attempt < 1024; attempt++) {
            const written = writeSync(fd, buffer, offset, buffer.length - offset);
            if (!written) throw new Error("core.errorLegacyExportWriteMadeNoProgress");
            offset += written;
        }
        if (offset !== buffer.length) throw new Error("core.errorLegacyExportWriteLimitExceeded");
    };
    const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === "bigint") return item <= BigInt(Number.MAX_SAFE_INTEGER) && item >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(item) : { type: "integer", value: String(item) };
        if (item instanceof Uint8Array) return { type: "blob", base64: Buffer.from(item).toString("base64") };
        return item;
    });
    try {
        write('{"version":1,"databases":[');
        for (const [index, source] of databases.entries()) {
            const schema = sqlIdentifier(source.schema);
            const tables = source.db.prepare(`SELECT name,sql FROM ${schema}.sqlite_master WHERE type='table' ORDER BY name LIMIT ?`).all(MAX_TABLES + 1);
            tableCount += tables.length;
            if (tableCount > MAX_TABLES) throw new Error("core.errorLegacyExportExceedsTheTableLimit");
            write(`${index ? "," : ""}{"name":${json(source.name)},"tables":[`);
            for (const [tableIndex, table] of tables.entries()) {
                const statement = source.db.prepare(`SELECT * FROM ${schema}.${sqlIdentifier(String(table.name))} LIMIT ?`);
                statement.setReadBigInts(true);
                write(`${tableIndex ? "," : ""}{"name":${json(table.name)},"sql":${json(table.sql)},"rows":[`);
                let firstRow = true;
                for (const row of statement.iterate(MAX_ROWS - rowCount + 1)) {
                    if (++rowCount > MAX_ROWS) throw new Error("core.errorLegacyExportExceedsTheRowLimit");
                    write(`${firstRow ? "" : ","}${json(row)}`);
                    firstRow = false;
                }
                write("]}");
            }
            write("]}");
        }
        write("]}\n");
    } catch (error) {
        closeSync(fd);
        unlinkSync(temporary);
        throw error;
    }
    closeSync(fd);
    try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
    return { path, tables: tableCount, rows: rowCount };
}
