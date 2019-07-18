// ag-grid-enterprise v21.1.0
import { ExcelOOXMLTemplate } from 'ag-grid-community';
export interface NumberFormat {
    formatCode: string;
    numFmtId: number;
}
declare const numberFormatFactory: ExcelOOXMLTemplate;
export default numberFormatFactory;
export declare const numberFormatMap: {
    [key: string]: number;
};
