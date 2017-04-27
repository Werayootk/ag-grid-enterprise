import {
    InfiniteCacheParams,
    _,
    Logger,
    IEnterpriseGetRowsRequest,
    RowNode,
    Context,
    PostConstruct,
    Autowired,
    Events,
    EventService,
    IEnterpriseCache,
    IEnterpriseDatasource,
    IEnterpriseGetRowsParams,
    NumberSequence,
    RowNodeBlock,
    RowNodeCache,
    RowNodeCacheParams,
    ColumnVO,
    Qualifier,
    LoggerFactory
} from "ag-grid";
import {EnterpriseRowModel} from "./enterpriseRowModel";
import {EnterpriseBlock} from "./enterpriseBlock";

export interface EnterpriseCacheParams extends RowNodeCacheParams {
    rowGroupCols: ColumnVO[];
    valueCols: ColumnVO[];
    datasource: IEnterpriseDatasource;
    lastAccessedSequence: NumberSequence;
}

// indexes change when:
// + group opened / closed
// + rows are loaded, as this will prob change the row count

export class EnterpriseCache extends RowNodeCache implements IEnterpriseCache {

    public static EVENT_CACHE_UPDATED = 'cacheUpdated';

    @Autowired('eventService') private eventService: EventService;
    @Autowired('context') private context: Context;

    private logger: Logger;

    private params: EnterpriseCacheParams;

    private blocks: {[blockNumber: string]: EnterpriseBlock} = {};
    private blocksCount = 0;

    // this will always be zero for the top level cache only,
    // all the other ones chance as the groups open and close
    private firstDisplayIndex: number = 0;
    private lastDisplayIndex: number;

    private parentRowNode: RowNode;

    constructor(params: EnterpriseCacheParams, parentRowNode: RowNode) {
        super(params);
        this.params = params;
        this.parentRowNode = parentRowNode;
    }

    private setBeans(@Qualifier('loggerFactory') loggerFactory: LoggerFactory) {
        this.logger = loggerFactory.create('EnterpriseCache');
    }

    protected dispatchModelUpdated(): void {
        if (this.isActive()) {
            this.dispatchEvent(EnterpriseCache.EVENT_CACHE_UPDATED);
        }
    }

    @PostConstruct
    private init(): void {
        // start load of data, as the virtualRowCount will remain at 0 otherwise,
        // so we need this to kick things off, otherwise grid would never call getRow()
        this.getRow(0);
    }

    public setDisplayIndexes(numberSequence: NumberSequence): void {
        this.firstDisplayIndex = numberSequence.peek();

        let lastBlockId = -1;

        this.forEachBlockInOrder( (blockId: number, currentBlock: EnterpriseBlock)=> {

            // if we skipped blocks, then we need to skip the row indexes. we assume that all missing
            // blocks are made up of closed RowNodes only (if they were groups), as we never expire from
            // the cache if any row nodes are open.
            let blocksSkippedCount = blockId - lastBlockId - 1;
            let rowsSkippedCount = blocksSkippedCount * this.params.pageSize;
            if (rowsSkippedCount>0) {
                numberSequence.skip(rowsSkippedCount);
            }

            lastBlockId = blockId;

            currentBlock.setDisplayIndexes(numberSequence, this.getVirtualRowCount());
        });

        // if any blocks missing at the end, need to increase the row index for them also
        // eg if block size = 10, we have total rows of 25 (indexes 0 .. 24), but first 2 blocks loaded (because
        // last row was ejected from cache), then:
        // lastVisitedRow = 19, virtualRowCount = 25, rows not accounted for = 5 (24 - 19)
        let lastVisitedRow = ((lastBlockId + 1) * this.params.pageSize) -1;
        let rowCount = this.getVirtualRowCount();
        let rowsNotAccountedFor = rowCount - lastVisitedRow - 1;
        if (rowsNotAccountedFor > 0) {
            numberSequence.skip(rowsNotAccountedFor);
        }

        this.lastDisplayIndex = numberSequence.peek() - 1;
    }

    private forEachBlockInOrder( callback: (blockId: number, block: EnterpriseBlock)=>void ): void {

        // list of block id's, they are NUMBERS, not strings, and sorted numerically
        let numberComparator = (a: number, b: number) => a - b; // default comparator for array is string comparison
        let blockIdsSorted = Object.keys(this.blocks).map( idStr => parseInt(idStr) ).sort(numberComparator);

        blockIdsSorted.forEach( blockId => {
            let currentBlock = this.blocks[blockId];
            callback(blockId, currentBlock);
        });
    }

    public getRow(rowIndex: number): RowNode {

        // if we have the block, then this is the block
        let block: EnterpriseBlock = null;
        // this is the last block that we have BEFORE the right block
        let beforeBlock: EnterpriseBlock = null;

        this.forEachBlockInOrder( (blockId: number, currentBlock: EnterpriseBlock)=> {
            if (currentBlock.isIndexInBlock(rowIndex)) {
                block = currentBlock;
            } else if (currentBlock.isBlockBefore(rowIndex)) {
                // this will get assigned many times, but the last time will
                // be the closest block to the required block that is BEFORE
                beforeBlock = currentBlock;
            }
        });

        // if block not found, we need to load it
        if (_.missing(block)) {

            let blockNumber: number;
            let displayIndexStart: number;

            // because missing blocks are always fully closed, we can work out
            // the start index of the block we want by hopping from the closes block,
            // as we know the row count in closed blocks is equal to the page size

            if (beforeBlock) {
                blockNumber = beforeBlock.getPageNumber();
                displayIndexStart = beforeBlock.getDisplayStartIndex();
                while (displayIndexStart < rowIndex) {
                    displayIndexStart += this.params.pageSize;
                    blockNumber++;
                }
            } else {
                let localIndex = rowIndex - this.firstDisplayIndex;
                blockNumber = localIndex / this.params.pageSize;
                displayIndexStart = this.firstDisplayIndex + (blockNumber * this.params.pageSize);
            }
            block = this.createBlock(blockNumber, displayIndexStart);

            this.logger.log(`block missing, rowIndex = ${rowIndex}, creating #${blockNumber}, displayIndexStart = ${displayIndexStart}`);
        }

        let rowNode = block.getRow(rowIndex);

        return rowNode;
    }

    private createBlock(blockNumber: number, displayIndex: number): EnterpriseBlock {

        let newBlock = new EnterpriseBlock(blockNumber, this.parentRowNode, this.params);
        this.context.wireBean(newBlock);

        let displayIndexSequence = new NumberSequence(displayIndex);
        newBlock.setDisplayIndexes(displayIndexSequence, this.getVirtualRowCount());

        newBlock.addEventListener(EnterpriseBlock.EVENT_LOAD_COMPLETE, this.onPageLoaded.bind(this));

        this.blocks[blockNumber] = newBlock;
        this.blocksCount++;
        //
        // let needToPurge = _.exists(this.cacheParams.maxBlocksInCache)
        //     && this.blocksCount > this.cacheParams.maxBlocksInCache;
        // if (needToPurge) {
        //     var lruPage = this.findLeastRecentlyUsedPage(newBlock);
        //     this.removeBlockFromCache(lruPage);
        // }
        //
        this.checkBlockToLoad();

        return newBlock;
    }

    private checkBlockToLoad() {

        var pageToLoad: EnterpriseBlock = null;
        _.iterateObject(this.blocks, (key: string, cachePage: EnterpriseBlock)=> {
            if (cachePage.getState() === EnterpriseBlock.STATE_DIRTY) {
                pageToLoad = cachePage;
            }
        });

        if (pageToLoad) {
            pageToLoad.load();
        }
    }

    private onPageLoaded(event: any): void {
        // if we are not active, then we ignore all events, otherwise we could end up getting the
        // grid to refresh even though we are no longer the active cache
        if (!this.isActive()) {
            return;
        }

        this.logger.log(`onPageLoaded: page = ${event.page.getPageNumber()}, lastRow = ${event.lastRow}`);
        // this.activePageLoadsCount--;
        // this.checkBlockToLoad();

        if (event.success) {
            this.checkVirtualRowCount(event.page, event.lastRow);
        }
    }

    public getLastDisplayedIndex(): number {
        return this.lastDisplayIndex;
    }

    public isIndexInCache(index: number): boolean {
        return index >= this.firstDisplayIndex && index <= this.lastDisplayIndex;
    }

}

