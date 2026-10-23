import { csvLine, parseCustomerCsv } from './customer-csv';

describe('Customer CSV boundary', () => {
  it('accepts BOM, quoted commas, escaped quotes, CRLF and multiline fields', () => {
    expect(parseCustomerCsv('\uFEFFname,company\r\n"Rudra, team","A ""quoted""\ncompany"\r\n')).toEqual([{ name:'Rudra, team',company:'A "quoted"\ncompany' }]);
  });
  it.each(['name,name\nA,B','unknown\nA','name,email\nA','name\n"unterminated','name\n"closed"tail','name\nA"quote','name\n'])('rejects malformed or unsupported CSV: %s', csv => {
    expect(()=>parseCustomerCsv(csv)).toThrow();
  });
  it('bounds record count and UTF-8 bytes rather than character count only', () => {
    expect(()=>parseCustomerCsv('name\n'+Array(251).fill('A').join('\n'))).toThrow('250');
    expect(()=>parseCustomerCsv('name\n'+'\u09ac'.repeat(180000))).toThrow('512');
    expect(()=>parseCustomerCsv('name\nA\u0000')).toThrow('control');
  });
  it('escapes commas/quotes and neutralizes formulas even after leading whitespace', () => {
    expect(csvLine(['=CMD()', ' +SUM(1)', '@x', 'Normal, "name"', null])).toBe('"\'=CMD()","\' +SUM(1)","\'@x","Normal, ""name""",""\r\n');
  });
});
