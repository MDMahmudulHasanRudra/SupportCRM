import { useRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useVisibleMessages } from './use-visible-messages';

let notify:IntersectionObserverCallback;
const observe=vi.fn();const disconnect=vi.fn();
let observerOptions:IntersectionObserverInit|undefined;
function Harness({read,enabled=true}:{read:(ids:string[])=>Promise<void>;enabled?:boolean}) {
  const root=useRef<HTMLDivElement>(null);
  useVisibleMessages(root,'conversation-one',enabled,read);
  return <div ref={root}><div data-readable-message="visible">Visible inbound</div><div data-readable-message="offscreen">Offscreen inbound</div><div>Outbound or system</div></div>;
}
function mockObserver(){
  vi.stubGlobal('IntersectionObserver',class {constructor(callback:IntersectionObserverCallback,options?:IntersectionObserverInit){notify=callback;observerOptions=options;}observe=observe;disconnect=disconnect;});
}
const entry=(target:Element,ratio:number)=>({target,isIntersecting:ratio>0,intersectionRatio:ratio}) as IntersectionObserverEntry;
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();observe.mockClear();disconnect.mockClear();});
it('records only visible inbound IDs, retains offscreen unread and disconnects on unmount',async()=>{
  mockObserver();const read=vi.fn().mockResolvedValue(undefined);const view=render(<Harness read={read}/>);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(observerOptions?.root).toBeUndefined(); // viewport clipping must apply even to an expanded mobile thread
  act(()=>notify([entry(view.getByText('Visible inbound'),1),entry(view.getByText('Offscreen inbound'),0.2)],{} as IntersectionObserver));
  await waitFor(()=>expect(read).toHaveBeenCalledWith(['visible']));
  view.unmount();expect(disconnect).toHaveBeenCalled();
});
it('does not record hidden-tab messages until the operator returns and cancels pending reads on selection change',async()=>{
  mockObserver();let hidden=true;
  vi.spyOn(document,'visibilityState','get').mockImplementation(()=>hidden?'hidden':'visible');
  const read=vi.fn().mockResolvedValue(undefined);const view=render(<Harness read={read}/>);
  act(()=>notify([entry(view.getByText('Visible inbound'),1)],{} as IntersectionObserver));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,340));});expect(read).not.toHaveBeenCalled();
  hidden=false;act(()=>document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(()=>expect(read).toHaveBeenCalledTimes(1));
  act(()=>notify([entry(view.getByText('Offscreen inbound'),1)],{} as IntersectionObserver));
  view.rerender(<Harness read={read} enabled={false}/>);
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,340));});expect(read).toHaveBeenCalledTimes(1);
});
