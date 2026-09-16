import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
const script = readFileSync(new URL("../../deploy/wordpress-size-chart/size-chart-choice.js", import.meta.url), "utf8");
describe("выбор размерной сетки коллаборации", () => {
 it("показывает только выбранную таблицу и скрывает все при сбросе выбора", () => {
  let change: () => void = () => { throw new Error("Обработчик не установлен"); };
  const panels = ["0", "1", "2"].map(id => ({dataset:{sizeChartPanel:id},hidden:false,style:{display:""}}));
  const selector = {value:"",getAttribute:()=>"panels",addEventListener:(event: string,fn: () => void)=>{if(event==="change")change=fn;}};
  let themeChange: (event: unknown) => void = () => { throw new Error("Обработчик темы не установлен"); };
  vm.runInNewContext(script,{document:{querySelector:()=>selector,getElementById:()=>({querySelectorAll:()=>panels}),addEventListener:(event: string,fn: (event: unknown) => void)=>{if(event==="selectCallback")themeChange=fn;}}});
  expect(panels.every(p=>p.hidden && p.style.display==="none")).toBe(true);
  selector.value="1";change();
  expect(panels.map(p=>p.hidden)).toEqual([true,false,true]);
  selector.value="2";themeChange({detail:{select:selector}});
  expect(panels.map(p=>p.hidden)).toEqual([true,true,false]);
  selector.value="";change();
  expect(panels.every(p=>p.hidden)).toBe(true);
 });
 it("не затрагивает страницу с единственной сеткой", () => {
  expect(()=>vm.runInNewContext(script,{document:{querySelector:()=>null}})).not.toThrow();
 });
});
