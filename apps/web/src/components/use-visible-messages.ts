import { useEffect, type RefObject } from 'react';

/** A read means the operator could see this specific inbound message, never a timestamp watermark. */
export function useVisibleMessages(root:RefObject<HTMLDivElement|null>,revision:unknown,enabled:boolean,onRead:(ids:string[])=>Promise<void>) {
  useEffect(()=>{
    const container=root.current;
    if(!container || !enabled || typeof IntersectionObserver==='undefined') return;
    const visible=new Set<Element>(); const acknowledged=new Set<string>();
    let disposed=false; let timer:ReturnType<typeof setTimeout>|undefined; let sending=false;
    const flush=async()=>{
      timer=undefined;
      if(disposed || sending || document.visibilityState!=='visible') return;
      const ids=[...visible].map(el=>el.getAttribute('data-readable-message')!).filter(id=>!acknowledged.has(id)).slice(0,200);
      if(!ids.length) return;
      sending=true;
      try { await onRead(ids); for(const id of ids) acknowledged.add(id); }
      catch { /* The thread retains an explicit retry action; do not spin on a failed API. */ }
      finally { sending=false; }
    };
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries) { if(entry.isIntersecting && entry.intersectionRatio>=0.6) visible.add(entry.target); else visible.delete(entry.target); }
      clearTimeout(timer); timer=setTimeout(()=>void flush(),300);
    // The implicit viewport root also clips against scrolling ancestors. An explicit thread root
    // would count offscreen messages when the mobile thread expands with the document.
    },{threshold:[0,0.6,1]});
    container.querySelectorAll('[data-readable-message]').forEach(el=>observer.observe(el));
    const resume=()=>{if(document.visibilityState==='visible') {clearTimeout(timer);timer=setTimeout(()=>void flush(),300);}};
    document.addEventListener('visibilitychange',resume);
    return ()=>{disposed=true;clearTimeout(timer);observer.disconnect();document.removeEventListener('visibilitychange',resume);};
  },[root,revision,enabled,onRead]);
}
