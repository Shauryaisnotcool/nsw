// One-time mechanical port of the existing, tested domain rules to async SQL.
// Generated files are checked in and maintained normally; this is not a build step.
import fs from 'node:fs';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
const traverse=traverseModule.default||traverseModule,generate=generateModule.default||generateModule;
const asyncCall=p=>{
 if(p.parentPath.isAwaitExpression())return;
 const f=p.getFunctionParent();if(!f)return;
 f.node.async=true;p.replaceWith(t.awaitExpression(p.node));p.skip();
};
const schemas=[];
for(const [source,target,className] of [['store','pg-store','PostgresStore'],['stats','pg-stats','PostgresStats'],['upi','pg-upi','PostgresUpi']]){
 const ast=parse(fs.readFileSync(`server/${source}.mjs`,'utf8'),{sourceType:'module'});
 traverse(ast,{
  ImportDeclaration(p){if(p.node.source.value==='node:sqlite')p.remove();},
  ClassDeclaration(p){p.node.id.name=className;},
  ClassMethod(p){
   if(p.node.kind==='constructor'){
    p.traverse({TemplateLiteral(q){if(q.node.quasis.length===1)schemas.push(q.node.quasis[0].value.cooked);}});
    const code=source==='store'?'this.db=db;this.now=now;':'this.store=store;';
    p.node.params=source==='store'?[t.identifier('db'),t.assignmentPattern(t.identifier('now'),t.memberExpression(t.identifier('Date'),t.identifier('now')))]:[t.identifier('store')];
    p.node.body=parse(`function x(){${code}}`).program.body[0].body;
   } else if(source==='store'&&p.node.key.name==='transaction'){
    p.node.body=parse('function x(){return this.db.transaction(fn);}').program.body[0].body;
   } else if(source==='store'&&p.node.key.name==='close'){
    p.node.body=parse('function x(){return this.db.close();}').program.body[0].body;
   }
  },
 });
 traverse(ast,{CallExpression:{exit(p){
  const callee=p.node.callee;
  if(!t.isMemberExpression(callee))return;
  const name=callee.property.name,object=generate(callee.object).code;
  if(name==='map'&&p.node.arguments[0]?.async){p.replaceWith(t.awaitExpression(t.callExpression(t.memberExpression(t.identifier('Promise'),t.identifier('all')),[p.node])));p.getFunctionParent().node.async=true;p.skip();return;}
  if(['get','all','run','exec'].includes(name)&&object.includes('.db.prepare(')||
     object==='this'&&!['now','image'].includes(name)||
     ['s','this.store','this.db'].includes(object)&&['transaction','close','captured'].includes(name))asyncCall(p);
 }}});
 fs.writeFileSync(`server/${target}.mjs`,generate(ast,{comments:true}).code+'\n');
}
fs.mkdirSync('server/migrations',{recursive:true});
fs.writeFileSync('server/migrations/sqlite-source.sql',schemas.join('\n'));
const ast=parse(fs.readFileSync('server/app.mjs','utf8'),{sourceType:'module'});
traverse(ast,{CallExpression:{exit(p){
 const c=p.node.callee;if(!t.isMemberExpression(c))return;
 const obj=generate(c.object).code,name=c.property.name;
 if(['store','stats','upi'].includes(obj)&&name!=='now'||obj.startsWith('store.db.prepare(')&&name==='get')asyncCall(p);
}}});
fs.writeFileSync('server/app.mjs',generate(ast,{comments:true}).code+'\n');
