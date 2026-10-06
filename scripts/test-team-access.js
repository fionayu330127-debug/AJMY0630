const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
require('dotenv').config({quiet:true});
const { Pool } = require('pg');
const pool = new Pool({connectionString: process.env.DATABASE_URL || 'postgres://postgres:agimia_erp_2026@127.0.0.1:5432/agimia_erp'});
const base = process.argv[2] || 'http://127.0.0.1:3002';
(async () => {
 const policy = fs.readFileSync('server.js','utf8').match(/function canManageTeam\(user\) \{[\s\S]*?\n\}/)[0];
 const check = vm.runInNewContext(policy + '; canManageTeam');
 for (const [user, expected] of [[{role:'member',team_group:'BOSS'},true],[{role:'boss'},true],[{role:'admin'},true],[{role:'member',team_group:'\u7ecf\u7406'},false],[null,false]]) assert.equal(check(user),expected);
 const tokens=[];
 try {
  const {rows} = await pool.query("SELECT DISTINCT ON (role, team_group) id, role, team_group FROM users WHERE status='active' ORDER BY role, team_group, id");
  assert(rows.some(u=>u.role==='admin'));
  assert(rows.some(u=>u.team_group==='BOSS'));
  assert(rows.some(u=>u.role==='member' && u.team_group!=='BOSS'));
  for(const u of [null,...rows]) {
   const allowed=!!u && (['admin','boss'].includes(u.role)||['\u7ba1\u7406\u5458','BOSS'].includes(u.team_group));
   const headers={'Content-Type':'application/json'};
   if(u){const token=crypto.randomUUID();tokens.push(token);await pool.query("INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,now()+interval '5 minutes')",[token,u.id]);headers.Cookie=`agi_session=${token}`;}
   for(const [method,path] of [['GET','/api/team'],['POST','/api/team/members'],['PATCH','/api/team/members/0'],['PATCH','/api/team/members/0/status']]){
    const res=await fetch(base+path,{method,headers,...(method==='GET'?{}:{body:'{}'})});
    assert.equal(res.status,!u?401:!allowed?403:method==='GET'?200:400,`${u?.role}/${u?.team_group} ${method} ${path}`);
   }
   if(u){const me=await fetch(base+'/api/me',{headers});assert.equal((await me.json()).user.can_manage_team,allowed);assert.equal((await fetch(base+'/api/weekly-reports',{headers})).status,200);}
   console.log(`PASS ${u ? u.role+'/'+u.team_group : 'anonymous'} access`);
  }
  const source=fs.readFileSync('app.js','utf8').split('bootstrap().catch')[0];
  const context=vm.createContext({document:{getElementById:()=>({})},console,localStorage:{getItem:()=>null},window:{}});
  vm.runInContext(source,context);
  for(const allowed of [false,true]){
   vm.runInContext(`state.auth={can_manage_team:${allowed}}`,context);
   const html=vm.runInContext('sidebarView()',context);
   assert.equal(html.includes('data-module="team"'),allowed);
   assert(html.includes('data-module="weekly-report"'));
  }
  console.log('PASS navigation visibility and weekly report access');
 } finally {if(tokens.length) await pool.query('DELETE FROM sessions WHERE token = ANY($1::text[])',[tokens]);await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
