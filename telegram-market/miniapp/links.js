// Main Mini App links have no app short name. startapp is a launch flag;
// its optional value is launch data, never the name of a registered app.
export const MARKET_LINK='https://t.me/WaseetIraqMarketBot?startapp';
export const MARKET_SHARE_LINK='https://t.me/share/url?'+new URLSearchParams({url:MARKET_LINK,text:'وسيط | سوق العراق — بيع واشتري داخل تلغرام'});
