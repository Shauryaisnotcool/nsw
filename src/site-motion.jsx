'use client';
import {useEffect} from 'react';
import {motion,useReducedMotion,useScroll,useSpring} from 'motion/react';

/** Decorative motion never delays content or hides it from reduced-motion users. */
export default function SiteMotion(){
 const reduced=useReducedMotion();
 const {scrollYProgress}=useScroll();
 const progress=useSpring(scrollYProgress,{stiffness:160,damping:30,mass:.25});
 useEffect(()=>{
  if(reduced||!('IntersectionObserver' in window))return;
  const nodes=[...document.querySelectorAll('.section-intro,.landscape-card,.feature-list>*,.plus-intro,.plans>*,.community>*,.join-section>*,.stats-title,.profile-empty')];
  const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
   if(entry.isIntersecting){entry.target.classList.remove('reveal-pending');observer.unobserve(entry.target);}
  }),{threshold:.08,rootMargin:'0px 0px -24px 0px'});
  nodes.forEach((node,index)=>{
   node.classList.add('scroll-reveal');
   node.style.setProperty('--reveal-delay',`${index%3*65}ms`);
   if(node.getBoundingClientRect().top>window.innerHeight){node.classList.add('reveal-pending');observer.observe(node);}
  });
  return()=>{observer.disconnect();nodes.forEach(node=>{node.classList.remove('reveal-pending','scroll-reveal');node.style.removeProperty('--reveal-delay');});};
 },[reduced]);
 return reduced?null:<motion.div aria-hidden="true" className="reading-progress" style={{scaleX:progress}}/>;
}
