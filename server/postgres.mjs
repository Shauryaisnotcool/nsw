import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {PostgresStore} from './pg-store.mjs';
import {PostgresStats} from './pg-stats.mjs';
import {PostgresUpi} from './pg-upi.mjs';

const TABLES=['users','issued_codes','challenges','sessions','consent','rate_limits','nonces','server_status','orders','game_profiles','game_presence','game_private','staff_roster','staff_sync','stats_sync','game_season','moderation_audit','upi_attempts'];
pg.types.setTypeParser(20,value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw Error('Database integer exceeds safe range');return n;});
function assetPath(relative){
 const candidates=[fileURLToPath(new URL('./'+relative,import.meta.url)),resolve(process.cwd(),relative),resolve(process.cwd(),'server',relative)];
 const found=candidates.find(existsSync);if(!found)throw Error('Database asset is missing: '+relative);return found;
}

// The domain queries are static SQL. Preserve their bound values and translate only
// the few SQLite constructs retained by the local/offline implementation.
export function sqlForPostgres(sql,schema='nugget_web'){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw Error('Invalid database schema');
 sql=sql.replace(/PRAGMA[^;]*;/g,'').replace(/\bINTEGER\b/g,'BIGINT').replace(/\bREAL\b/g,'DOUBLE PRECISION');
 sql=sql.replace('MAX(plus_until,','GREATEST(plus_until,');
 sql=sql.replace("json_extract(payload,'$.ratings.overall.elo')","(payload::jsonb #>> '{ratings,overall,elo}')::bigint");
 sql=sql.replace('name COLLATE NOCASE','lower(name)');
 if(sql.includes('INSERT OR IGNORE'))sql=sql.replace('INSERT OR IGNORE','INSERT')+' ON CONFLICT DO NOTHING';
 let parameter=0;
 return sql.split(/('(?:''|[^'])*')/g).map((part,index)=>index%2?part:part.replace(new RegExp('\\b('+TABLES.join('|')+')\\b','g'),name=>`"${schema}".${name}`).replace(/\?/g,()=>'$'+(++parameter))).join('');
}

export class PostgresDatabase {
 constructor(url,{schema='nugget_web',max=2}={}){
  sqlForPostgres('',schema);this.schema=schema;this.context=new AsyncLocalStorage();
  // Do not let URI sslmode options silently override certificate verification.
  const uri=new URL(url);for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])uri.searchParams.delete(key);
  this.pool=new pg.Pool({connectionString:uri.href,max,connectionTimeoutMillis:10000,idleTimeoutMillis:20000,allowExitOnIdle:true,
   ssl:{rejectUnauthorized:true,ca:readFileSync(assetPath('certs/supabase-ca.crt'),'utf8')},
   statement_timeout:15000,query_timeout:20000});
  this.pool.on('error',error=>console.error('[database connection]',error.code||'connection failure'));
 }
 async query(sql,values=[]){return (this.context.getStore()||this.pool).query(sqlForPostgres(sql,this.schema),values);}
 prepare(sql){return {
  get:async(...values)=>(await this.query(sql,values)).rows[0],
  all:async(...values)=>(await this.query(sql,values)).rows,
  run:async(...values)=>({changes:(await this.query(sql,values)).rowCount}),
 };}
 async bulk(table,columns,rows,conflict=''){
  if(!rows.length)return;
  if(!TABLES.includes(table)||columns.some(c=>!/^\w+$/.test(c)))throw Error('Invalid bulk table');
  const tuples=rows.map(()=>`(${columns.map(()=>'?').join(',')})`).join(',');
  await this.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples} ${conflict}`,rows.flat());
 }
 async transaction(fn){
  if(this.context.getStore())return fn();
  const client=await this.pool.connect();
  try{
   await client.query('BEGIN');
   // Match SQLite's serialized write transactions across all serverless instances.
   // Locks are transaction-scoped, so Supavisor transaction pooling is safe.
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[this.schema+':write']);
   const result=await this.context.run(client,fn);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 async migrate(){
  await this.transaction(async()=>{
   const client=this.context.getStore();
   await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
   await this.query(readFileSync(assetPath('migrations/sqlite-source.sql'),'utf8'));
   await client.query(`REVOKE ALL ON SCHEMA "${this.schema}" FROM PUBLIC, anon, authenticated`);
   await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${this.schema}" FROM PUBLIC, anon, authenticated`);
   for(const table of TABLES)await client.query(`ALTER TABLE "${this.schema}".${table} ENABLE ROW LEVEL SECURITY`);
  });
 }
 async close(){await this.pool.end();}
}

export async function openPostgresStore(url,options={}){
 const db=new PostgresDatabase(url,options);
 try{
  if(options.migrate)await db.migrate();
  else await db.query('SELECT 1 FROM users LIMIT 0');
  const store=new PostgresStore(db,options.now||Date.now);
  store.stats=new PostgresStats(store);store.upi=new PostgresUpi(store);
  return store;
 }catch(error){await db.close();throw error;}
}
