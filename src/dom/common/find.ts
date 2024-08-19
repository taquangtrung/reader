import { DisplayedAnnotation } from "./components/overlay/annotation-overlay";
import { executeSearch, InternalSearchContext } from "./lib/dom-text-search";
import { FindState } from "../../common/types";
import { PersistentRange } from "./lib/range";
import EPUBView from "../epub/epub-view";

export interface FindProcessor {
	getAnnotations(): FindAnnotation[];
}

class DefaultFindProcessor implements FindProcessor {
	readonly findState: FindState;

	private readonly _buf: FindResult[];

	private _pos: number | null = null;

	private _initialPos: number | null = null;

	private readonly _onSetFindState?: (state?: FindState) => void;

	private readonly _annotationKeyPrefix?: string;

	constructor(options: {
		findState: FindState,
		onSetFindState?: (state?: FindState) => void,
		annotationKeyPrefix?: string,
	}) {
		this.findState = options.findState;
		this._onSetFindState = options.onSetFindState;
		this._annotationKeyPrefix = options.annotationKeyPrefix;

		this._buf = [];
	}

	async run(searchContext: SearchContext, startRange?: Range | PersistentRange) {
		if (startRange instanceof PersistentRange) {
			startRange = startRange.toRange();
		}
		let charDataMap: CharacterData[] = [];
		let internalSearchContext: InternalSearchContext = {
			text: searchContext.text,
			internalCharDataRanges: searchContext.charDataRanges.map((charDataRange) => {
				let charDataID = charDataMap.length;
				charDataMap.push(charDataRange.charData);
				return {
					charDataID,
					start: charDataRange.start,
					end: charDataRange.end,
				};
			}),
		};
		let ranges = await executeSearch(
			internalSearchContext,
			this.findState.query,
			{
				caseSensitive: this.findState.caseSensitive,
				entireWord: this.findState.entireWord
			}
		);
		for (let internalOutputRange of ranges) {
			let range = new Range();
			range.setStart(charDataMap[internalOutputRange.startCharDataID], internalOutputRange.startIndex);
			range.setEnd(charDataMap[internalOutputRange.endCharDataID], internalOutputRange.endIndex);
			let persistentRange = new PersistentRange(range);
			let findResult: FindResult = {
				range: persistentRange,
				highlight: {
					type: 'highlight',
					color: 'rgba(180, 0, 170, 1)',
					text: '',
					key: 'findResult_' + (this._annotationKeyPrefix || '') + '_' + this._buf.length,
					range: persistentRange,
				}
			};
			if (this._initialPos === null && startRange) {
				if (EPUBView.compareBoundaryPoints(Range.START_TO_START, range, startRange) >= 0) {
					this._initialPos = this._buf.length;
				}
			}
			this._buf.push(findResult);
		}
		this._setFindState();
	}

	prev(loop = true): FindResult | null {
		if (this._pos === null) {
			if (this._initialPos === null) {
				this._pos = this._buf.length - 1;
			}
			else {
				this._pos = this._initialPos;
				this._initialPos = null;
			}
		}
		else {
			this._pos--;
			if (loop) {
				this._pos %= this._buf.length;
				if (this._pos < 0) {
					this._pos = this._buf.length - 1;
				}
			}
		}
		this._setFindState();
		return this.current;
	}

	next(loop = true): FindResult | null {
		if (this._pos === null) {
			if (this._initialPos === null) {
				this._pos = 0;
			}
			else {
				this._pos = this._initialPos;
				this._initialPos = null;
			}
		}
		else {
			this._pos++;
			if (loop) {
				this._pos %= this._buf.length;
			}
		}
		this._setFindState();
		return this.current;
	}

	get position(): number | null {
		return this._pos;
	}

	set position(value) {
		this._pos = value;
		this._setFindState();
	}

	get initialPosition(): number | null {
		return this._initialPos;
	}

	get current(): FindResult | null {
		if (this._pos === null || this._pos < 0 || this._pos >= this._buf.length) {
			return null;
		}
		return this._buf[this._pos];
	}

	getResults(): FindResult[] {
		return this._buf;
	}

	getAnnotations(): FindAnnotation[] {
		let selected
			= (this._pos !== null && this._pos >= 0 && this._pos < this._buf.length)
				? this._buf[this._pos]
				: null;
		let highlights: FindAnnotation[] = [];
		if (this.findState.highlightAll) {
			for (let result of this._buf) {
				if (selected === result) {
					highlights.push({
						...result.highlight,
						color: 'rgba(0, 100, 0, 1)'
					});
				}
				else {
					highlights.push(result.highlight);
				}
			}
		}
		else if (selected) {
			highlights.push({
				...selected.highlight,
				color: 'rgba(0, 100, 0, 1)'
			});
		}
		return highlights;
	}

	getSnippets(): string[] {
		return this._buf.map(({ range }) => {
			let snippet = range.toString();
			if (range.startContainer.nodeValue && range.startOffset > 0) {
				let textBeforeRange = range.startContainer.nodeValue.substring(0, range.startOffset);
				let beforeContext = textBeforeRange.match(/\b([\w\W]){1,20}$/);
				if (beforeContext) {
					snippet = beforeContext[0].trimStart() + snippet;
					if (beforeContext[0] != textBeforeRange) {
						snippet = '…' + snippet;
					}
				}
			}
			if (range.endContainer.nodeValue && range.endOffset < range.endContainer.nodeValue.length) {
				let textAfterRange = range.endContainer.nodeValue.substring(range.endOffset);
				let afterContext = textAfterRange.match(/^([\w\W]){1,20}\b/);
				if (afterContext) {
					snippet += afterContext[0].trimEnd();
					if (afterContext[0] != textAfterRange) {
						snippet += '…';
					}
				}
			}
			return snippet;
		});
	}

	private _setFindState() {
		if (this._onSetFindState) {
			this._onSetFindState({
				...this.findState,
				result: {
					total: this._buf.length,
					index: this._pos === null ? 0 : this._pos,
					snippets: this.getSnippets(),
				}
			});
		}
	}
}

export function createSearchContext(nodes: CharacterData[]): SearchContext {
	let text = '';
	let charDataRanges: CharDataRange[] = [];
	for (let charData of nodes) {
		let data = normalize(charData.data);
		charDataRanges.push({
			charData,
			start: text.length,
			end: text.length + data.length - 1,
		});
		text += data;
	}
	return { text, charDataRanges };
}

function normalize(s: string) {
	return s
		// Remove smart quotes
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"');
}

export type FindAnnotation = Omit<DisplayedAnnotation, 'range'> & { range: PersistentRange };

export type SearchContext = {
	text: string;
	charDataRanges: CharDataRange[];
}

export type CharDataRange = {
	charData: CharacterData;
	start: number;
	end: number;
}

export type OutputRange = {
	startCharData: CharacterData;
	endCharData: CharacterData;
	startIndex: number;
	endIndex: number;
}

export type FindResult = {
	range: PersistentRange;
	highlight: FindAnnotation;
}

export default DefaultFindProcessor;
