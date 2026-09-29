'use client';
import {useEffect,useState,useRef} from 'react';
import {RotateCw,Coins} from 'lucide-react';
export default function SeasonBanner(){
 const [season,setSeason]=useState(null);const previous=useRef(null);
 useEffect(()=>{const abort=new AbortController();let live=true;const load=async()=>{try{const r=await fetch('/api/season',{cache:'no-store',signal:abort.signal});if(r.ok){const body=await r.json();if(live){if(previous.current!==null&&previous.current!==body.current)window.dispatchEvent(new Event('nugget-season'));previous.current=body.current;setSeason(body);}}}catch{}};load();const timer=setInterval(load,5000);return()=>{live=false;abort.abort();clearInterval(timer);};},[]);
 if(!season)return null;
 const resetting=season.phase==='resetting';
 return <aside className={'season-banner'+(resetting?' resetting':'')} aria-live="polite">{resetting?<RotateCw size={18}/>:<Coins size={18}/>}<span>{resetting?<>Thanks for playing Season {season.current}. <strong>Season {season.next} is being prepared.</strong> Rejoin in 5–10 minutes. Your Nuggets stay with you.</>:<><strong>Season {season.current}</strong><span className="season-divider"> / </span>Five ranked wins. 100 Nuggets. Spend them anywhere.</>}</span></aside>;
}
