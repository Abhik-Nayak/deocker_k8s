import { pool } from "../db/pool";

export type LinkRow = {
  id: string;
  code: string;
  target_url: string;
  clicks: number;
  user_id: string | null;
  created_at: Date;
};

/** Postgres unique-violation, i.e. the random code collided. */
export const UNIQUE_VIOLATION = "23505";

export async function insert(
  code: string,
  targetUrl: string,
  userId: string | null
): Promise<LinkRow> {
  const { rows } = await pool.query<LinkRow>(
    `INSERT INTO links (code, target_url, user_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [code, targetUrl, userId]
  );
  return rows[0];
}

export async function findByUser(userId: string): Promise<LinkRow[]> {
  const { rows } = await pool.query<LinkRow>(
    `SELECT * FROM links WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

/** Bumps the click count and hands back the destination in one round trip. */
export async function findByCodeAndCountClick(
  code: string
): Promise<LinkRow | undefined> {
  const { rows } = await pool.query<LinkRow>(
    `UPDATE links SET clicks = clicks + 1 WHERE code = $1 RETURNING *`,
    [code]
  );
  return rows[0];
}
