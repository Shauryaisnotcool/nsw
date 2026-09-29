const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const KITS=['crystal','sword','mace','spear_mace','netherite_pot','axe','uhc','sumo'];
export function tier(elo){return elo<800?'Coal':elo<1000?'Copper':elo<1200?'Iron':elo<1400?'Gold':elo<1600?'Emerald':elo<1800?'Diamond':'Netherite';}
export class PlayerStats {
 constructor(store){this.store=store;store.db.exec(`CREATE TABLE IF NOT EXISTS game_profiles(uuid TEXT PRIMARY KEY,name TEXT NOT NULL,name_search TEXT NOT NULL,payload TEXT NOT NULL,updated INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS game_profile_search ON game_profiles(name_search);
 CREATE TABLE IF NOT EXISTS game_presence(uuid TEXT PRIMARY KEY,role TEXT NOT NULL,captured INTEGER NOT NULL,inventory TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS game_private(uuid TEXT PRIMARY KEY,punishments TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS staff_roster(uuid TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS staff_sync(id INTEGER PRIMARY KEY CHECK(id=1),received INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS stats_sync(id INTEGER PRIMARY KEY CHECK(id=1),received INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS game_season(id INTEGER PRIMARY KEY CHECK(id=1),current INTEGER NOT NULL,next INTEGER NOT NULL,phase TEXT NOT NULL,changed INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS moderation_audit(actor TEXT NOT NULL,target TEXT NOT NULL,action TEXT NOT NULL,created INTEGER NOT NULL);`);}
 season(){const r=this.store.db.prepare('SELECT * FROM game_season WHERE id=1').get();return r?{current:r.current,next:r.next,phase:r.phase,changedAt:r.changed}:{current:1,next:1,phase:'ready',changedAt:0};}
 setSeason(body){
  const {current,next,phase,changedAt}=body;
  if(!Number.isSafeInteger(current)||current<1||current>2147483647||!Number.isSafeInteger(next)||next<current||next>2147483647||!['ready','resetting'].includes(phase)||!Number.isSafeInteger(changedAt)||changedAt<0||phase==='ready'&&next!==current||phase==='resetting'&&next<=current)throw Error('Invalid season state');
  const previous=this.season();if(current<previous.current || current===previous.current&&changedAt<previous.changedAt)return false;
  this.store.transaction(()=>{
   if(current>previous.current)this.clearSeasonStats();
   this.store.db.prepare('INSERT INTO game_season VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET current=excluded.current,next=excluded.next,phase=excluded.phase,changed=excluded.changed').run(current,next,phase,changedAt);
  });return true;
 }
 clearSeasonStats(){for(const table of ['game_profiles','game_presence','game_private','stats_sync'])this.store.db.prepare('DELETE FROM '+table).run();}
 ingest(body){
  if(!Array.isArray(body.profiles)||body.profiles.length>240||!Array.isArray(body.online)||body.online.length>1000)throw Error('Invalid telemetry batch');
  const now=this.store.now();
  const season=body.season??this.season().current;
  if(!Number.isSafeInteger(season)||season<1||season>2147483647||season<this.season().current)throw Error('Stale or invalid season telemetry');
  const roster=body.staff===undefined?null:body.staff;
  if(roster!==null&&(!Array.isArray(roster)||roster.length>10000||roster.some(p=>!UUID.test(p.uuid)||typeof p.name!=='string'||!p.name.length||p.name.length>32||!['owner','admin','mod'].includes(p.role))||new Set(roster.map(p=>p.uuid)).size!==roster.length))throw Error('Invalid staff roster');
  const profiles=body.profiles.map(p=>{
   if(!UUID.test(p.uuid)||typeof p.name!=='string'||p.name.length>32||!p.name.length)throw Error('Invalid player');
   for(const key of ['lastSeen','playtime','money','nuggets','spent7d','earned7d'])if(!Number.isSafeInteger(p[key])||p[key]<0)throw Error('Invalid metric');
   const ratings={};for(const kit of ['overall',...KITS]){const r=p.ratings?.[kit];if(!r||!['elo','wins','losses'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0))throw Error('Invalid rating');ratings[kit]={elo:r.elo,wins:r.wins,losses:r.losses,tier:tier(r.elo)};}
   const {uuid,name,lastSeen,playtime,money,nuggets,spent7d,earned7d}=p;
   const rewardWins=p.rewardWins??0;if(!Number.isSafeInteger(rewardWins)||rewardWins<0)throw Error("Invalid reward progress");
   return {public:{uuid,name,lastSeen,playtime,money,nuggets,spent7d,earned7d,rewardWins,ratings},punishments:Array.isArray(p.punishments)?p.punishments.slice(0,30):[]};
  });
  const presence=body.online.map(p=>{if(!UUID.test(p.uuid)||!['owner','admin','mod','media','plus','member'].includes(p.role)||!Number.isSafeInteger(p.captured)||p.captured>now+60000||!Array.isArray(p.inventory)||p.inventory.length>41)throw Error('Invalid presence');return {...p,captured:Math.min(p.captured,now),inventory:p.inventory.map(i=>({slot:i.slot,item:String(i.item).slice(0,64),amount:i.amount}))};});
  this.store.transaction(()=>{
   if(season>this.season().current){this.clearSeasonStats();this.store.db.prepare('INSERT INTO game_season VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET current=excluded.current,next=excluded.next,phase=excluded.phase,changed=excluded.changed').run(season,season,'ready',now);}
   if(roster!==null){this.store.db.prepare('DELETE FROM staff_roster').run();for(const p of roster)this.store.db.prepare('INSERT INTO staff_roster VALUES(?,?,?)').run(p.uuid,p.name,p.role);this.store.db.prepare('INSERT INTO staff_sync VALUES(1,?) ON CONFLICT(id) DO UPDATE SET received=excluded.received').run(now);}
   for(const p of profiles){this.store.db.prepare('INSERT INTO game_profiles VALUES(?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,name_search=excluded.name_search,payload=excluded.payload,updated=excluded.updated').run(p.public.uuid,p.public.name,p.public.name.toLowerCase(),JSON.stringify(p.public),now);this.store.db.prepare('INSERT INTO game_private VALUES(?,?) ON CONFLICT(uuid) DO UPDATE SET punishments=excluded.punishments').run(p.public.uuid,JSON.stringify(p.punishments));}
   this.store.db.prepare('INSERT INTO stats_sync VALUES(1,?) ON CONFLICT(id) DO UPDATE SET received=excluded.received').run(now);
   this.store.db.prepare('DELETE FROM game_presence').run();for(const p of presence)this.store.db.prepare('INSERT INTO game_presence VALUES(?,?,?,?)').run(p.uuid,p.role,p.captured,JSON.stringify(p.inventory));
  });
 }
 profile(row){if(!row)return null;const p=JSON.parse(row.payload),presence=this.store.db.prepare('SELECT captured FROM game_presence WHERE uuid=?').get(p.uuid);const online=!!presence&&this.store.now()-presence.captured<=20000;const latest=this.store.db.prepare('SELECT received FROM stats_sync WHERE id=1').get()?.received;const globalRank=1+this.store.db.prepare("SELECT COUNT(*) AS n FROM game_profiles WHERE json_extract(payload,'$.ratings.overall.elo')>?").get(p.ratings.overall.elo).n;return {...p,globalRank,online,lastSeen:Math.max(p.lastSeen,presence?.captured||0),syncedAt:row.updated,stale:this.store.now()-row.updated>30000,serverStatusKnown:!!latest&&this.store.now()-latest<=20000};}
 search(query='',page=0){const q=query.trim().toLowerCase().slice(0,32);let rows;if(q){const escaped=q.replace(/[\\%_]/g,'\\$&');rows=this.store.db.prepare("SELECT * FROM game_profiles WHERE name_search LIKE ? ESCAPE '\\' ORDER BY name_search LIMIT 24 OFFSET ?").all(escaped+'%',page*24);}else rows=this.store.db.prepare('SELECT p.* FROM game_profiles p LEFT JOIN game_presence o ON p.uuid=o.uuid ORDER BY CASE WHEN o.captured>? THEN 0 ELSE 1 END,p.name_search LIMIT 24 OFFSET ?').all(this.store.now()-20000,page*24);return rows.map(r=>this.profile(r));}
 get(uuid){if(!UUID.test(uuid))return null;return this.profile(this.store.db.prepare('SELECT * FROM game_profiles WHERE uuid=?').get(uuid));}
 roster(){const syncedAt=this.store.db.prepare('SELECT received FROM staff_sync WHERE id=1').get()?.received||null;const stale=!syncedAt||this.store.now()-syncedAt>30000;return {members:stale?[]:this.store.db.prepare("SELECT uuid,name,role FROM staff_roster ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,name COLLATE NOCASE").all(),syncedAt,stale};}
 staff(uuid){const p=this.store.db.prepare('SELECT role,captured FROM game_presence WHERE uuid=?').get(uuid);return p&&this.store.now()-p.captured<=15000&&['owner','admin','mod'].includes(p.role)?p.role:null;}
 inspect(actor,uuid,kind){if(!this.staff(actor))return null;if(!UUID.test(uuid))return null;this.store.db.prepare('INSERT INTO moderation_audit VALUES(?,?,?,?)').run(actor,uuid,kind,this.store.now());if(kind==='inventory'){const p=this.store.db.prepare('SELECT inventory,captured FROM game_presence WHERE uuid=?').get(uuid);return p&&this.store.now()-p.captured<=20000?{items:JSON.parse(p.inventory),captured:p.captured}:{items:null,captured:null};}const p=this.store.db.prepare('SELECT punishments FROM game_private WHERE uuid=?').get(uuid);return {punishments:p?JSON.parse(p.punishments):[]};}
}
