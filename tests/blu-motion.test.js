// Run: node tests/blu-motion.test.js
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'..','blu-motion.js'),'utf8');
const MACS=['aa:bb:cc:00:00:01','aa:bb:cc:00:00:02','aa:bb:cc:00:00:03'];
function run(startOn=false,timing=false,configuredSensors=null) {
 let now=1000,output=startOn,receiver=null,periodic=null;
 const calls=[],logs=[],published=[];
 const ctx={
   console:{log:(...args)=>logs.push(args.join(' '))},
   Shelly:{
     getComponentConfig:()=>({enable:true}),
     getComponentStatus:()=>({output}),
     getUptimeMs:()=>now,
     call:(method,args,cb)=>{assert.equal(method,'Switch.Set');calls.push(args.on);output=args.on;cb({},0,null);}
   },
   BLE:{Scanner:{
     SCAN_RESULT:2,INFINITE_SCAN:-1,isRunning:()=>false,
     subscribe:fn=>{receiver=fn;},start:()=>true
   }},
   Timer:{set:(ms,repeating,fn)=>{periodic=fn;}},
   MQTT:{isConnected:()=>true,publish:(topic,value)=>{published.push({topic,value});return true;}}
 };
 // Shelly MJS binary string .at(index) returns a byte; Node String.at returns a character.
 vm.runInNewContext('String.prototype.at=function(i){return this.charCodeAt(i);};',ctx);
 let source=timing?script.replace('diagnoseMotionTiming: false','diagnoseMotionTiming: true'):script;
 if(configuredSensors!==null) {
   source=source.replace(/\ninit\(\);\s*$/, '\nCONFIG.sensors='+JSON.stringify(configuredSensors)+';\ninit();');
 }
 vm.runInNewContext(source,ctx,{filename:'blu-motion.js'});
 if(configuredSensors===null || configuredSensors.some(x=>x && typeof x.mac==='string' && MACS.includes(x.mac))) {
   assert.equal(typeof receiver,'function');
   assert.equal(typeof periodic,'function');
 }
 function packet(sensor,pid,motion,options={}) {
   const bytes=[0x40,0x00,pid];
   if(options.button)bytes.push(0x3a,1);
   bytes.push(0x21,motion);
   if(options.battery!==undefined)bytes.push(0x01,options.battery);
   if(options.lux!==undefined)bytes.push(0x05,options.lux&255,(options.lux>>8)&255,(options.lux>>16)&255);
   receiver(2,{addr:options.addr || MACS[sensor],rssi:-67,service_data:{fcd2:String.fromCharCode(...bytes)}});
 }
 return {packet,calls,published,logs,tick:()=>periodic(),advance:ms=>{now+=ms;},get output(){return output;}};
}
function test(name,fn){fn();console.log('PASS '+name);}
test('startup does not force switch',()=>{const x=run(true);x.tick();assert.equal(x.output,true);});
test('BTHome 0x3a is one byte; motion after it is decoded',()=>{const x=run();x.packet(0,3,1,{button:true});assert.equal(x.output,true);});
test('three sensors use OR logic',()=>{const x=run();[0,1,2].forEach(i=>x.packet(i,1,1));x.packet(0,2,0);x.packet(1,2,0);assert.equal(x.output,true);x.packet(2,2,0);assert.equal(x.output,false);});
test('identical packet IDs from different devices accepted',()=>{const x=run();x.packet(0,20,1);x.packet(1,20,1);x.packet(0,21,0);assert.equal(x.output,true);});
test('duplicate packet ID from same device discarded briefly',()=>{const x=run();x.packet(0,10,1);x.packet(0,10,0);assert.equal(x.output,true);x.advance(3000);x.packet(0,10,0);assert.equal(x.output,false);});
test('active-state timeout remains enabled',()=>{const x=run();x.packet(0,1,1);x.advance(901000);x.tick();assert.equal(x.output,false);});
test('fresh motion report refreshes timeout',()=>{const x=run();x.packet(0,1,1);x.advance(850000);x.packet(0,2,1);x.advance(850000);x.tick();assert.equal(x.output,true);x.advance(100000);x.tick();assert.equal(x.output,false);});
test('illuminance MQTT topic retained',()=>{const x=run();x.packet(0,1,0,{lux:125});assert.deepEqual(x.published[0],{topic:MACS[0]+'/illuminance',value:'1.25'});});
test('diagnostic log includes gap RSSI and battery',()=>{const x=run(false,true);x.packet(0,1,1,{battery:89});x.advance(120000);x.packet(0,2,0,{battery:89});assert.ok(x.logs.some(s=>s.includes('TIMING Sensor 1 motion=0 gapMs=120000 rssi=-67 battery=89')));});

test('one configured sensor switches on and off immediately',()=>{
 const x=run(false,false,[{name:'Only sensor',mac:MACS[0]}]);
 assert.ok(x.logs.some(line=>line.includes('started with 1 sensor(s)')));
 x.packet(1,1,1); // Other sensors must be ignored.
 assert.equal(x.output,false);
 x.packet(0,1,1);assert.equal(x.output,true);
 x.packet(1,2,0);assert.equal(x.output,true);
 x.packet(0,2,0);assert.equal(x.output,false);
 assert.deepEqual(x.calls,[true,false]);
});
test('two configured sensors use OR logic',()=>{
 const x=run(false,false,[{name:'First',mac:MACS[0]},{name:'Second',mac:MACS[1]}]);
 assert.ok(x.logs.some(line=>line.includes('started with 2 sensor(s)')));
 x.packet(0,1,1);x.packet(1,1,1);x.packet(0,2,0);
 assert.equal(x.output,true);
 x.packet(1,2,0);assert.equal(x.output,false);
});
test('four configured sensors also work without a hard-coded maximum',()=>{
 const extra='aa:bb:cc:00:00:04';
 const sensors=[...MACS,extra].map((mac,index)=>({name:'Sensor '+index,mac}));
 const x=run(false,false,sensors);
 assert.ok(x.logs.some(line=>line.includes('started with 4 sensor(s)')));
 x.packet(3,1,1,{addr:extra});assert.equal(x.output,true);
 x.packet(3,2,0,{addr:extra});assert.equal(x.output,false);
});
test('empty configuration does not initialize BLE or operate the relay',()=>{
 const x=run(true,false,[]);
 assert.equal(x.output,true);
 assert.equal(x.calls.length,0);
 assert.ok(x.logs.some(line=>line.includes('No valid motion sensors configured')));
});
test('invalid sensor MAC addresses do not start control',()=>{
 const x=run(true,false,[{name:'Invalid',mac:'not-a-mac'}]);
 assert.equal(x.output,true);
 assert.equal(x.calls.length,0);
 assert.ok(x.logs.some(line=>line.includes('Invalid sensor MAC address')));
});
test('duplicate sensor MAC addresses count only once',()=>{
 const x=run(false,false,[{name:'First',mac:MACS[0]},{name:'Second',mac:MACS[0]}]);
 assert.ok(x.logs.some(line=>line.includes('Duplicate sensor MAC address')));
 assert.ok(x.logs.some(line=>line.includes('started with 1 sensor(s)')));
 x.packet(0,1,1);assert.equal(x.output,true);
});
