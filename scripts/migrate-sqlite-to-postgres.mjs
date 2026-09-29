import {DatabaseSync} from 'node:sqlite';
import {openPostgresStore} from '../server/postgres.mjs';

const sqlitePath=process.env.SQLITE_PATH||'data/nugget-website.db';
const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw Error('Set DATABASE_URL in an ignored environment file before migrating.');
const sqlite=new DatabaseSync(sqlitePath,{readOnly:true});
const store=await openPostgresStore(databaseUrl,{schema:process.env.SUPABASE_DB_SCHEMA||'nugget_web',max:1,migrate:true});
const tables=['users','issued_codes','challenges','sessions','consent','server_status','orders','game_profiles','game_presence','game_private','staff_roster','staff_sync','stats_sync','game_season','moderation_audit','upi_attempts'];
let total=0;
try{
 for(const table of tables){
  const exists=sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if(!exists)continue;
  const columns=sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(row=>row.name);
  const rows=sqlite.prepare(`SELECT * FROM "${table}"`).all();
  if(!columns.length||!rows.length)continue;
  await store.db.transaction(async()=>{
   const query=`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`;
   for(const row of rows)await store.db.prepare(query).run(...columns.map(column=>row[column]));
  });
  total+=rows.length;
  console.log(`${table}: ${rows.length} row(s) considered`);
 }
 console.log(`Migration complete: ${total} row(s) considered. Existing Supabase rows were preserved.`);
}finally{
 sqlite.close();
 await store.close();
}
