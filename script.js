const SUPABASE_URL="https://snbavhdmagfufvpiocrf.supabase.co";
const REST_API=SUPABASE_URL+"/rest/v1";
const API=REST_API+"/parts_public";
const TABLE_API=REST_API+"/Parts";
const MOVEMENT_API=REST_API+"/stock_movements";
const WARNING_API=REST_API+"/stock_warning_rules";
const RPC_API=REST_API+"/rpc";
const API_KEY="sb_publishable_PPTLw8gmtTmpbaKq_uP07Q_nWmTYSjt";
const SESSION_STORAGE_KEY="partsInventoryStaffSession";
const BULK_TEMPLATE_KEY="partsInventoryBulkTemplates";
const INVENTORY_VIEW_KEY="partsInventoryView";
const DEFAULT_LOW_STOCK_LIMIT=2;
const INVENTORY_PAGE_SIZE=24;

let allParts=[];
let movements=[];
let bulkItems=[];
let selectedMovementPart=null;
let warningRules=[];
let inventorySessionToken="";
let inventoryLoaded=false;
let inventoryPage=1;
let inventoryView=localStorage.getItem(INVENTORY_VIEW_KEY)==="table"?"table":"cards";
let csvImportRows=[];
let scannerStream=null;
let scannerFrame=0;
let sessionTimer=0;
let dashboardMovementsLoaded=false;
const pendingPartChanges=new Set();

function requestHeaders(headers={},includeSession=true){
const result={
apikey:API_KEY,
Authorization:"Bearer "+API_KEY,
...headers
};
if(includeSession&&inventorySessionToken){
result["x-inventory-session"]=inventorySessionToken;
}
return result;
}

async function apiFetch(url,options={},includeSession=true){
return fetch(url,{
...options,
headers:requestHeaders(options.headers||{},includeSession)
});
}

async function apiRequest(url,options={},includeSession=true){
const response=await apiFetch(url,options,includeSession);
if(response.ok)return response;

let message="Request failed.";
const body=await response.text();
try{
const payload=body?JSON.parse(body):{};
message=payload.message||payload.hint||message;
}catch{
if(body)message=body;
}

if(includeSession&&(response.status===401||response.status===403)){
clearStaffSession();
showLogin("Your session has expired. Please sign in again.");
}

throw new Error(message);
}

async function apiJson(url,options={},includeSession=true){
const response=await apiRequest(url,options,includeSession);
const text=await response.text();
return text?JSON.parse(text):null;
}

function callRpc(name,parameters={},includeSession=true){
return apiJson(RPC_API+"/"+name,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify(parameters)
},includeSession);
}

function setText(id,value){
const element=document.getElementById(id);
if(element)element.textContent=value;
}

function setAppStatus(message,type=""){
const status=document.getElementById("appStatus");
if(!status)return;
status.textContent=message;
status.className="app-status"+(type?" "+type:"");
}

function showActionError(error){
console.error(error);
const message=error?.message||"Something went wrong.";
setAppStatus(message,"error");
alert(message);
}

function setButtonBusy(id,busy,busyText,readyText){
const button=document.getElementById(id);
if(!button)return;
button.disabled=busy;
button.textContent=busy?busyText:readyText;
}

function activateStaffSession(session){
inventorySessionToken=session.session_token;
sessionStorage.setItem(SESSION_STORAGE_KEY,JSON.stringify(session));
startSessionClock(session.expires_at);
}

function clearStaffSession(){
inventorySessionToken="";
inventoryLoaded=false;
clearInterval(sessionTimer);
setText("sessionCountdown","");
sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function getStoredStaffSession(){
try{
const value=sessionStorage.getItem(SESSION_STORAGE_KEY);
return value?JSON.parse(value):null;
}catch{
return null;
}
}

function showLogin(message=""){
document.getElementById("loginScreen").style.display="flex";
setText("loginError",message);
}

async function openInventory(){
document.getElementById("loginScreen").style.display="none";
setText("loginError","");
if(!inventoryLoaded){
await loadParts();
inventoryLoaded=true;
}
}

async function checkPassword(){
const password=document.getElementById("passwordInput").value;
if(!password){
setText("loginError","Enter the password.");
return;
}

setButtonBusy("loginButton",true,"Checking...","Unlock");
try{
const result=await callRpc("authenticate_inventory_staff",{p_password:password},false);
const session=Array.isArray(result)?result[0]:result;
if(!session?.session_token){
setText("loginError","Incorrect password.");
return;
}
activateStaffSession(session);
document.getElementById("passwordInput").value="";
await openInventory();
}catch(error){
console.error(error);
setText("loginError",error.message||"Could not sign in.");
}finally{
setButtonBusy("loginButton",false,"Checking...","Unlock");
}
}

async function restoreStaffSession(){
const stored=getStoredStaffSession();
if(!stored?.session_token){
showLogin();
return;
}

inventorySessionToken=stored.session_token;
startSessionClock(stored.expires_at);
try{
const valid=await callRpc("validate_inventory_staff_session");
if(valid===true){
await openInventory();
return;
}
}catch(error){
console.error(error);
}

clearStaffSession();
showLogin("Your session has expired. Please sign in again.");
}

async function logout(){
try{
if(inventorySessionToken)await callRpc("end_inventory_staff_session");
}catch(error){
console.error(error);
}finally{
clearStaffSession();
location.reload();
}
}

function toggleMenu(){
if(matchMedia("(min-width: 901px)").matches)return;
const menu=document.getElementById("sideMenu");
const open=menu.classList.toggle("open");
document.getElementById("menuButton")?.setAttribute("aria-expanded",String(open));
}

function closeMenu(){
const menu=document.getElementById("sideMenu");
menu?.classList.remove("open");
document.getElementById("menuButton")?.setAttribute("aria-expanded","false");
}

function startSessionClock(expiresAt){
clearInterval(sessionTimer);
const expiry=new Date(expiresAt).getTime();
const update=()=>{
const remaining=expiry-Date.now();
if(!Number.isFinite(remaining)||remaining<=0){
clearStaffSession();
showLogin("Your session has expired. Please sign in again.");
return;
}
const minutes=Math.ceil(remaining/60000);
setText("sessionCountdown",minutes<=10?`Session expires in ${minutes} min`:"");
if(minutes===10)setAppStatus("Your session expires in about 10 minutes.","error");
};
update();
sessionTimer=setInterval(update,30000);
}

const PAGE_ACTIVATORS={
dashboardPage:renderDashboard,
searchPage:searchParts,
editPage:showEditParts,
stockPage:showStockWarnings,
reorderPage:renderReorderList,
warningSettingsPage:showWarningSettings,
movementPage(){
selectedMovementPart=null;
document.getElementById("selectedMovePart").className="card";
document.getElementById("selectedMovePart").innerHTML="No part selected.";
showMovementSearchResults();
},
bulkPage(){
showBulkSearchResults();
renderBulkTable();
populateBulkTemplates();
},
historyPage:loadMovements,
importPage:resetImportPage,
duplicatesPage:renderDuplicateReview
};

const PAGE_TITLES={dashboardPage:"Dashboard",searchPage:"Inventory",addPage:"Add Part",editPage:"Edit Parts",stockPage:"Stock Warnings",reorderPage:"Reorder List",warningSettingsPage:"Warning Settings",movementPage:"Stock In / Out",bulkPage:"Bulk Job Issue",historyPage:"Usage History",importPage:"Import Parts",duplicatesPage:"Duplicate Review",mapPage:"Location Map"};

function showPage(page){
document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
document.getElementById(page).classList.add("active");
setText("currentPageTitle",PAGE_TITLES[page]||"Inventory");
document.body.classList.toggle("map-mode",page==="mapPage");
document.querySelectorAll("#sideMenu button[data-page]").forEach(button=>{
button.setAttribute("aria-current",button.dataset.page===page?"page":"false");
});
PAGE_ACTIVATORS[page]?.();
}

async function loadParts(){
setAppStatus("Loading inventory...");
try{
const [parts,rules]=await Promise.all([
apiJson(API+"?select=*&order=part_name.asc"),
apiJson(WARNING_API+"?select=*&order=part_type.asc")
]);
allParts=Array.isArray(parts)?parts:[];
warningRules=Array.isArray(rules)?rules:[];
populateInventoryFilters();
searchParts(false);
showStockWarnings();
renderDashboard();
renderReorderList();
renderBulkTable();
renderDuplicateReview();
setAppStatus("");
}catch(error){
showActionError(error);
throw error;
}
}

async function loadWarningRules(){
const rules=await apiJson(WARNING_API+"?select=*&order=part_type.asc");
warningRules=Array.isArray(rules)?rules:[];
}

function qty(p){
return Number(p.quantity||0);
}

function encodeInlineValue(value){
return encodeURIComponent(value).replace(/'/g,"%27");
}

function encodePart(part){
return encodeInlineValue(JSON.stringify(part));
}

function decodePart(encoded){
return JSON.parse(decodeURIComponent(encoded));
}

function getPartMutationUrl(part,checkVersion=false){
const id=Number(part?.id);
if(!Number.isSafeInteger(id)||id<1)throw new Error("This part has no stable database ID.");
const version=Number(part?.version);
return TABLE_API+"?id=eq."+id+(checkVersion&&Number.isSafeInteger(version)?"&version=eq."+version:"");
}

function findWarningRule(partType){
return warningRules.find(rule=>
String(rule.part_type||"").toLowerCase()===String(partType||"").toLowerCase()
);
}

function getWarningLevel(partType){
const rule=findWarningRule(partType);

return rule?Number(rule.warning_level||DEFAULT_LOW_STOCK_LIMIT):DEFAULT_LOW_STOCK_LIMIT;
}

function cardClass(p){
if(qty(p)<=0)return"card critical"+(p.manually_low?" manual-low":"");
if(isPartLow(p))return"card low"+(p.manually_low?" manual-low":"");

return"card";
}

function isPartLow(part){
return Boolean(part?.manually_low)||qty(part)<=getWarningLevel(part?.part_type);
}

function stockStatus(part){
if(qty(part)<=0)return {key:"out",label:"Out of stock",className:"critical"};
if(part.manually_low)return {key:"manual",label:"Manually marked low",className:"low manual"};
if(isPartLow(part))return {key:"low",label:"Low stock",className:"low"};
return {key:"healthy",label:"Healthy",className:""};
}

function safeExternalUrl(value){
try{
const url=new URL(String(value||""));
return url.protocol==="https:"||url.protocol==="http:"?url.href:"";
}catch{return "";}
}

function partMatches(p,s){
return JSON.stringify(p).toLowerCase().includes(s);
}

function populateInventoryFilters(){
const supplier=document.getElementById("inventorySupplierFilter");
const type=document.getElementById("inventoryTypeFilter");
if(!supplier||!type)return;
const supplierValue=supplier.value;
const typeValue=type.value;
supplier.innerHTML='<option value="">All suppliers</option>'+uniqueSorted(allParts.map(part=>part.supplier_name)).map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
type.innerHTML='<option value="">All part types</option>'+uniqueSorted(allParts.map(part=>part.part_type)).map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
supplier.value=supplierValue;
type.value=typeValue;
}

function filteredInventoryParts(){
const search=(document.getElementById("search")?.value||"").toLowerCase();
const supplier=document.getElementById("inventorySupplierFilter")?.value||"";
const type=document.getElementById("inventoryTypeFilter")?.value||"";
const stock=document.getElementById("inventoryStockFilter")?.value||"";
const sort=document.getElementById("inventorySort")?.value||"name-asc";
const list=allParts.filter(part=>{
if(search&&!partMatches(part,search))return false;
if(supplier&&part.supplier_name!==supplier)return false;
if(type&&part.part_type!==type)return false;
const status=stockStatus(part);
if(stock==="low"&&!isPartLow(part))return false;
if(stock==="manual"&&!part.manually_low)return false;
if(stock==="healthy"&&status.key!=="healthy")return false;
if(stock==="out"&&status.key!=="out")return false;
return true;
});
const text=(value)=>String(value||"").toLowerCase();
list.sort((a,b)=>{
if(sort==="name-desc")return text(b.part_name).localeCompare(text(a.part_name));
if(sort==="quantity-asc")return qty(a)-qty(b);
if(sort==="quantity-desc")return qty(b)-qty(a);
if(sort==="supplier-asc")return text(a.supplier_name).localeCompare(text(b.supplier_name));
if(sort==="location-asc")return text(`${a.rack} ${a.shelf} ${a.drawer}`).localeCompare(text(`${b.rack} ${b.shelf} ${b.drawer}`));
return text(a.part_name).localeCompare(text(b.part_name));
});
return list;
}

function searchParts(resetPage=true){
if(resetPage)inventoryPage=1;
showParts(filteredInventoryParts());
}

function clearInventoryFilters(){
["search","inventorySupplierFilter","inventoryTypeFilter","inventoryStockFilter"].forEach(id=>{const field=document.getElementById(id);if(field)field.value="";});
const sort=document.getElementById("inventorySort");
if(sort)sort.value="name-asc";
inventoryPage=1;
searchParts(false);
}

function setInventoryView(view){
inventoryView=view==="table"?"table":"cards";
localStorage.setItem(INVENTORY_VIEW_KEY,inventoryView);
searchParts(false);
}

function renderPartCard(part){
const encoded=encodePart(part);
const encodedLocation=encodeInlineValue(JSON.stringify({rack:part.rack||"",shelf:part.shelf||"",drawer:part.drawer||""}));
const warning=getWarningLevel(part.part_type);
const status=stockStatus(part);

const description=part.description||"";
const area=part.area||"";

return `
<div class="${cardClass(part)}">
<h2>${escapeHtml(part.part_name||"")}</h2>
<span class="stock-badge ${status.className}">${escapeHtml(status.label)}</span>
<p><b>Supplier / Manufacturer:</b> ${escapeHtml(part.supplier_name||"")}</p>
<p><b>Manufacturer Part Number:</b> ${escapeHtml(part.manufacturer_part_number||"")}</p>
<p><b>Part Type:</b> ${escapeHtml(part.part_type||"")}</p>
${description?`<p><b>Description:</b> ${escapeHtml(description)}</p>`:""}

<p class="qty"><b>Quantity:</b> ${qty(part)}</p>
<p class="small">Warning level for this type: ${warning}</p>

${safeExternalUrl(part.image_url)?`<img class="part-image" src="${escapeHtml(safeExternalUrl(part.image_url))}" alt="Image of ${escapeHtml(part.part_name||"part")}" loading="lazy">`:""}
<div class="reference-links">
${safeExternalUrl(part.supplier_url)?`<a href="${escapeHtml(safeExternalUrl(part.supplier_url))}" target="_blank" rel="noopener noreferrer">Supplier page</a>`:""}
${safeExternalUrl(part.datasheet_url)?`<a href="${escapeHtml(safeExternalUrl(part.datasheet_url))}" target="_blank" rel="noopener noreferrer">Datasheet</a>`:""}
</div>

<div class="card-actions">
<button class="qty-btn" onclick="changeQuantityFromEncoded('${encoded}',${qty(part)-1},'MANUAL OUT','')">-</button>
<button class="qty-btn" onclick="changeQuantityFromEncoded('${encoded}',${qty(part)+1},'MANUAL IN','')">+</button>
<button onclick="setManualLowFromEncoded('${encoded}',${part.manually_low?"false":"true"})">${part.manually_low?"Clear manual low":"Mark as low"}</button>
</div>

<p class="location">
${part.rack?"Rack "+escapeHtml(part.rack):""}
${part.shelf?" | Shelf "+escapeHtml(part.shelf):""}
${part.drawer?" | Drawer "+escapeHtml(part.drawer):""}
${area?" | Area "+escapeHtml(area):""}
</p>

<button onclick="showMapFromEncoded('${encodedLocation}')">View Location on Map</button>
</div>`;
}

function showParts(parts){
const results=document.getElementById("results");
if(!results)return;
const totalPages=Math.max(1,Math.ceil(parts.length/INVENTORY_PAGE_SIZE));
inventoryPage=Math.min(Math.max(1,inventoryPage),totalPages);
const start=(inventoryPage-1)*INVENTORY_PAGE_SIZE;
const pageParts=parts.slice(start,start+INVENTORY_PAGE_SIZE);
setText("inventoryResultSummary",`${parts.length} matching part${parts.length===1?"":"s"} · Page ${inventoryPage} of ${totalPages}`);
document.getElementById("cardViewButton")?.setAttribute("aria-pressed",String(inventoryView==="cards"));
document.getElementById("tableViewButton")?.setAttribute("aria-pressed",String(inventoryView==="table"));
if(!pageParts.length){
results.innerHTML='<div class="empty-state"><h3>No matching parts</h3><p>Try clearing the filters or add a new inventory record.</p><button onclick="clearInventoryFilters()">Clear filters</button></div>';
}else if(inventoryView==="table"){
results.innerHTML=renderInventoryTable(pageParts);
}else{
results.innerHTML='<div class="inventory-card-grid">'+pageParts.map(renderPartCard).join("")+'</div>';
}
renderInventoryPagination(totalPages);
}

function renderInventoryTable(parts){
return `<div class="table-wrap"><table class="inventory-table"><caption class="sr-only">Filtered parts inventory</caption><thead><tr><th scope="col">Part</th><th scope="col">Supplier</th><th scope="col">Type</th><th scope="col">Location</th><th scope="col">Quantity</th><th scope="col">Actions</th></tr></thead><tbody>${parts.map(part=>{
const encoded=encodePart(part);
const status=stockStatus(part);
return `<tr><td><span class="part-name">${escapeHtml(part.part_name||"")}</span><br><span class="small">${escapeHtml(part.manufacturer_part_number||"")}</span></td><td>${escapeHtml(part.supplier_name||"")}</td><td>${escapeHtml(part.part_type||"")}</td><td>${escapeHtml([part.rack,part.shelf,part.drawer].filter(value=>value!==null&&value!=="").join(" / "))}</td><td>${qty(part)}<br><span class="stock-badge ${status.className}">${escapeHtml(status.label)}</span></td><td><div class="card-actions"><button class="qty-btn" onclick="changeQuantityFromEncoded('${encoded}',${qty(part)-1},'MANUAL OUT','')">−</button><button class="qty-btn" onclick="changeQuantityFromEncoded('${encoded}',${qty(part)+1},'MANUAL IN','')">+</button><button onclick="setManualLowFromEncoded('${encoded}',${part.manually_low?"false":"true"})">${part.manually_low?"Clear low":"Mark low"}</button></div></td></tr>`;
}).join("")}</tbody></table></div>`;
}

function renderInventoryPagination(totalPages){
const box=document.getElementById("inventoryPagination");
if(!box)return;
if(totalPages<=1){box.innerHTML="";return;}
const pages=[];
for(let page=Math.max(1,inventoryPage-2);page<=Math.min(totalPages,inventoryPage+2);page++)pages.push(`<button aria-current="${page===inventoryPage?"page":"false"}" onclick="goToInventoryPage(${page})">${page}</button>`);
box.innerHTML=`<button onclick="goToInventoryPage(${inventoryPage-1})" ${inventoryPage===1?"disabled":""}>Previous</button>${pages.join("")}<button onclick="goToInventoryPage(${inventoryPage+1})" ${inventoryPage===totalPages?"disabled":""}>Next</button>`;
}

function goToInventoryPage(page){
inventoryPage=page;
searchParts(false);
document.getElementById("searchPage")?.scrollIntoView({behavior:"smooth",block:"start"});
}

function showStockWarnings(){
const low=[...allParts]
.filter(isPartLow)
.sort((a,b)=>Number(b.manually_low)-Number(a.manually_low)||qty(a)-qty(b));

document.getElementById("stockResults").innerHTML=low.length
? low.map(renderPartCard).join("")
: `<div class="card"><h2>No low stock items</h2></div>`;
}

function setManualLowFromEncoded(encoded,manuallyLow){
return setManualLow(decodePart(encoded),manuallyLow);
}

async function setManualLow(part,manuallyLow){
try{
const rows=await apiJson(getPartMutationUrl(part,true),{method:"PATCH",headers:{"Content-Type":"application/json",Prefer:"return=representation"},body:JSON.stringify({manually_low:Boolean(manuallyLow)})});
if(Array.isArray(rows)&&rows.length===0)throw new Error("This part changed in another session. Refresh and try again.");
await loadParts();
setAppStatus(manuallyLow?"Part marked as low stock.":"Manual low-stock mark cleared.","success");
}catch(error){showActionError(error);}
}

function showWarningSettings(){
const partTypes=[...new Set(allParts.map(p=>p.part_type||"Unknown").filter(Boolean))].sort();

document.getElementById("warningSettingsResults").innerHTML=`
<div class="table-wrap">
<table>
<caption class="sr-only">Warning levels by part type</caption>
<thead>
<tr><th scope="col">Part Type</th><th scope="col">Warning Level</th><th scope="col">Save</th></tr>
</thead>
<tbody>
${partTypes.map((type,i)=>`
<tr>
<td>${escapeHtml(type)}</td>
<td><label class="sr-only" for="warn-${i}">Warning level for ${escapeHtml(type)}</label><input id="warn-${i}" type="number" min="0" step="1" value="${getWarningLevel(type)}"></td>
<td><button onclick="saveWarningRule('${encodeInlineValue(type)}','warn-${i}')">Save</button></td>
</tr>
`).join("")}
</tbody>
</table>
</div>`;
}

async function saveWarningRule(encodedType,inputId){
const type=decodeURIComponent(encodedType);
const level=Number(document.getElementById(inputId).value);

if(!Number.isInteger(level)||level<0){
alert("Enter a whole-number warning level of zero or more.");
return;
}

const existing=findWarningRule(type);

try{
if(existing){
await apiRequest(WARNING_API+"?id=eq."+existing.id,{
method:"PATCH",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({warning_level:level})
});
}else{
await apiRequest(WARNING_API,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({part_type:type,warning_level:level})
});
}
await loadWarningRules();
showWarningSettings();
showStockWarnings();
setAppStatus("Warning level saved.","success");
}catch(error){
showActionError(error);
}
}

function changeQuantityFromEncoded(encoded,newQty,type,job){
return changeQuantity(decodePart(encoded),newQty,type,job);
}

async function changeQuantity(part,newQty,type="UPDATE",job="",notes=""){
const oldQty=qty(part);
const targetQty=Math.max(0,Number(newQty));
const delta=targetQty-oldQty;

if(!part.id){
showActionError(new Error("This part has no stable database ID."));
return false;
}
if(!Number.isInteger(targetQty)){
showActionError(new Error("Quantity must be a whole number."));
return false;
}
if(delta===0)return true;
if(pendingPartChanges.has(part.id))return false;

pendingPartChanges.add(part.id);
try{
const result=await callRpc("inventory_adjust_stock",{
p_part_id:part.id,
p_delta:delta,
p_movement_type:type,
p_job_number:String(job||"").trim(),
p_notes:String(notes||"").trim()
});
const row=Array.isArray(result)?result[0]:result;
const savedQty=Number(row?.new_quantity);
if(!Number.isInteger(savedQty))throw new Error("The server returned an invalid stock quantity.");
const savedVersion=Number(row?.new_version);

const index=allParts.findIndex(item=>item.id===part.id);
if(index!==-1){
allParts[index].quantity=savedQty;
if(Number.isSafeInteger(savedVersion))allParts[index].version=savedVersion;
}

if(selectedMovementPart?.id===part.id){
selectedMovementPart.quantity=savedQty;
selectMovementPart(encodePart(selectedMovementPart));
}

searchParts(false);
showStockWarnings();
renderDashboard();
renderReorderList();
renderBulkTable();
return true;
}catch(error){
showActionError(error);
return false;
}finally{
pendingPartChanges.delete(part.id);
}
}

function fieldValue(id){
return document.getElementById(id)?.value.trim()||"";
}

function setFieldValues(values){
Object.entries(values).forEach(([id,value])=>{
const field=document.getElementById(id);
if(!field)return;
if(field.type==="checkbox")field.checked=Boolean(value);
else field.value=value;
});
}

function optionalNumber(id){
const value=fieldValue(id);
return value===""?null:Number(value);
}

function validatePartValues(values){
if(!values.name)return "Enter a part name.";
if(values.name.length>200||values.supplier.length>200||values.mpn.length>200||values.type.length>100)return "One or more part fields are too long.";
if(values.description.length>2000||values.area.length>500)return "The description or area is too long.";
if(!Number.isInteger(values.quantity)||values.quantity<0)return "Quantity must be a whole number of zero or more.";
if(values.shelf!==null&&(!Number.isInteger(values.shelf)||values.shelf<0))return "Shelf must be a whole number of zero or more.";
if(values.reorderQuantity!==null&&(!Number.isInteger(values.reorderQuantity)||values.reorderQuantity<0))return "Reorder quantity must be a whole number of zero or more.";
if(values.purchasePrice!==null&&(!Number.isFinite(values.purchasePrice)||values.purchasePrice<0))return "Purchase price must be zero or more.";
for(const [label,url] of [["supplier page",values.supplierUrl],["datasheet",values.datasheetUrl],["image",values.imageUrl]]){
if(url&&!safeExternalUrl(url))return `Enter a valid http or https URL for the ${label}.`;
}
return "";
}

function readNewPartValues(){
const shelfText=fieldValue("newShelf");
return {
name:fieldValue("newPartName"),
supplier:fieldValue("newSupplier"),
mpn:fieldValue("newMPN"),
type:fieldValue("newType"),
description:fieldValue("newDescription"),
rack:fieldValue("newRack"),
shelf:shelfText===""?null:Number(shelfText),
drawer:fieldValue("newDrawer"),
area:fieldValue("newArea"),
quantity:Number(fieldValue("newQuantity")||0),
manuallyLow:Boolean(document.getElementById("newManuallyLow")?.checked),
reorderQuantity:optionalNumber("newReorderQuantity"),
supplierUrl:fieldValue("newSupplierUrl"),
datasheetUrl:fieldValue("newDatasheetUrl"),
imageUrl:fieldValue("newImageUrl"),
purchasePrice:optionalNumber("newPurchasePrice")
};
}

function partPayload(values,includeQuantity=true){
const payload={
"Part Name":values.name,
"Supplier Name":values.supplier,
"Manufacturer Part Number":values.mpn,
"Part Type":values.type,
"Description":values.description,
"Rack":values.rack,
"Shelf":values.shelf,
"Drawer":values.drawer,
"Area":values.area,
manually_low:Boolean(values.manuallyLow),
reorder_quantity:values.reorderQuantity,
supplier_url:values.supplierUrl||null,
datasheet_url:values.datasheetUrl||null,
image_url:values.imageUrl||null,
purchase_price:values.purchasePrice
};
if(includeQuantity)payload.Quantity=values.quantity;
return payload;
}

async function addPart(){
const values=readNewPartValues();
const validationError=validatePartValues(values);
if(validationError){alert(validationError);return;}
const duplicate=values.mpn&&allParts.find(part=>String(part.manufacturer_part_number||"").toLowerCase()===values.mpn.toLowerCase());
if(duplicate&&!await confirmAction("Possible duplicate",`${duplicate.part_name} already uses part number ${values.mpn}. Add another record anyway?`,"Add anyway"))return;

setButtonBusy("addPartButton",true,"Adding...","Add Part");
try{
await apiRequest(TABLE_API,{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify(partPayload(values))
});
await loadParts();
setFieldValues({newPartName:"",newSupplier:"",newMPN:"",newType:"",newDescription:"",newRack:"",newShelf:"",newDrawer:"",newArea:"",newQuantity:"",newManuallyLow:false,newReorderQuantity:"",newSupplierUrl:"",newDatasheetUrl:"",newImageUrl:"",newPurchasePrice:""});
showPage("searchPage");
setAppStatus("Part added.","success");
}catch(error){
showActionError(error);
}finally{
setButtonBusy("addPartButton",false,"Adding...","Add Part");
}
}

function escapeHtml(value){
return String(value ?? "")
.replace(/&/g,"&amp;")
.replace(/</g,"&lt;")
.replace(/>/g,"&gt;")
.replace(/"/g,"&quot;")
.replace(/'/g,"&#039;");
}

function showEditParts(){
const s=(document.getElementById("editSearch")?.value||"").toLowerCase();
const list=allParts.filter(p=>partMatches(p,s));

document.getElementById("editResults").innerHTML=list.map((p,i)=>{
const encoded=encodePart(p);

return `
<div class="card">
<h2>${escapeHtml(p.part_name||"")}</h2>

<label class="sr-only" for="epn-${i}">Part name</label>
<input id="epn-${i}" value="${escapeHtml(p.part_name||"")}" placeholder="Part Name">
<label class="sr-only" for="esup-${i}">Supplier</label>
<input id="esup-${i}" value="${escapeHtml(p.supplier_name||"")}" placeholder="Supplier">
<label class="sr-only" for="empn-${i}">Manufacturer part number</label>
<input id="empn-${i}" value="${escapeHtml(p.manufacturer_part_number||"")}" placeholder="Manufacturer Part Number">
<label class="sr-only" for="etype-${i}">Part type</label>
<input id="etype-${i}" value="${escapeHtml(p.part_type||"")}" placeholder="Part Type">
<label class="sr-only" for="edesc-${i}">Description</label>
<textarea id="edesc-${i}" placeholder="Description">${escapeHtml(p.description||"")}</textarea>
<label class="sr-only" for="erack-${i}">Rack</label>
<input id="erack-${i}" value="${escapeHtml(p.rack||"")}" placeholder="Rack">
<label class="sr-only" for="eshelf-${i}">Shelf</label>
<input id="eshelf-${i}" type="number" min="0" step="1" value="${escapeHtml(p.shelf||"")}" placeholder="Shelf">
<label class="sr-only" for="edrawer-${i}">Drawer</label>
<input id="edrawer-${i}" value="${escapeHtml(p.drawer||"")}" placeholder="Drawer">
<label class="sr-only" for="earea-${i}">Area</label>
<input id="earea-${i}" value="${escapeHtml(p.area||"")}" placeholder="Area">
<label class="sr-only" for="eqty-${i}">Quantity</label>
<input id="eqty-${i}" type="number" min="0" step="1" value="${qty(p)}" placeholder="Quantity">
<label class="checkbox-label"><input id="emanual-${i}" type="checkbox" ${p.manually_low?"checked":""}> Mark as low stock manually</label>
<label for="ereorder-${i}">Suggested reorder quantity</label>
<input id="ereorder-${i}" type="number" min="0" step="1" value="${escapeHtml(p.reorder_quantity??"")}" placeholder="Suggested reorder quantity">
<label for="esupplierurl-${i}">Supplier page</label>
<input id="esupplierurl-${i}" type="url" value="${escapeHtml(p.supplier_url||"")}" placeholder="https://supplier.example/part">
<label for="edatasheet-${i}">Datasheet</label>
<input id="edatasheet-${i}" type="url" value="${escapeHtml(p.datasheet_url||"")}" placeholder="https://example.com/datasheet.pdf">
<label for="eimage-${i}">Image URL</label>
<input id="eimage-${i}" type="url" value="${escapeHtml(p.image_url||"")}" placeholder="https://example.com/image.jpg">
<label for="eprice-${i}">Purchase price</label>
<input id="eprice-${i}" type="number" min="0" step="0.01" value="${escapeHtml(p.purchase_price??"")}" placeholder="0.00">

<button id="save-edit-${i}" onclick="saveEditFromEncoded('${encoded}',${i})">Save Changes</button>
<button class="delete-btn" onclick="deletePartFromEncoded('${encoded}')">Delete Part</button>
</div>`;
}).join("");
}

function saveEditFromEncoded(encoded,index){
const part=decodePart(encoded);
saveEdit(part,index);
}

async function saveEdit(part,index){
const shelfText=fieldValue("eshelf-"+index);
const values={
name:fieldValue("epn-"+index),
supplier:fieldValue("esup-"+index),
mpn:fieldValue("empn-"+index),
type:fieldValue("etype-"+index),
description:fieldValue("edesc-"+index),
rack:fieldValue("erack-"+index),
shelf:shelfText===""?null:Number(shelfText),
drawer:fieldValue("edrawer-"+index),
area:fieldValue("earea-"+index),
quantity:Number(fieldValue("eqty-"+index)||0),
manuallyLow:Boolean(document.getElementById("emanual-"+index)?.checked),
reorderQuantity:optionalNumber("ereorder-"+index),
supplierUrl:fieldValue("esupplierurl-"+index),
datasheetUrl:fieldValue("edatasheet-"+index),
imageUrl:fieldValue("eimage-"+index),
purchasePrice:optionalNumber("eprice-"+index)
};
const validationError=validatePartValues(values);
if(validationError){alert(validationError);return;}

setButtonBusy("save-edit-"+index,true,"Saving...","Save Changes");
try{
const updated=await apiJson(getPartMutationUrl(part,true),{
method:"PATCH",
headers:{
"Content-Type":"application/json",
Prefer:"return=representation"
},
body:JSON.stringify(partPayload(values,false))
});
if(Array.isArray(updated)&&updated.length===0)throw new Error("This part changed in another session. Refresh and review the latest values before saving.");
if(values.quantity!==qty(part)){
await callRpc("inventory_adjust_stock",{
p_part_id:part.id,
p_delta:values.quantity-qty(part),
p_movement_type:values.quantity>qty(part)?"MANUAL IN":"MANUAL OUT",
p_job_number:"Edit Parts",
p_notes:"Quantity changed while editing the part"
});
}
await loadParts();
showEditParts();
setAppStatus("Part updated.","success");
}catch(error){
showActionError(error);
}finally{
setButtonBusy("save-edit-"+index,false,"Saving...","Save Changes");
}
}

function deletePartFromEncoded(encoded){
const part=decodePart(encoded);
deletePart(part);
}

async function deletePart(part){
const partName=part.part_name||"this part";
const mpn=part.manufacturer_part_number||"No part number";

if(!await confirmAction("Delete part",`Delete ${partName} (${mpn})? This cannot be undone.`,"Delete")){
return;
}

try{
await apiRequest(getPartMutationUrl(part),{
method:"DELETE",
headers:{
Prefer:"return=representation"
}
});
await loadParts();
showEditParts();
setAppStatus("Part deleted.","success");
}catch(error){
showActionError(error);
}
}

function showMovementSearchResults(){
const box=document.getElementById("moveSearchResults");
if(!box)return;

const s=(document.getElementById("moveSearch")?.value||"").toLowerCase();

if(!s){
box.innerHTML=`<div class="card"><p>Search for a part to select it.</p></div>`;
return;
}

const matches=allParts.filter(p=>partMatches(p,s)).slice(0,20);

box.innerHTML=matches.length?matches.map(p=>{
const encoded=encodePart(p);

const selected=selectedMovementPart?.id===p.id;

return `
<div class="${selected?'card selected-stock':'card'}">
<h2>${escapeHtml(p.part_name||"")}</h2>
<p><b>Supplier / Manufacturer:</b> ${escapeHtml(p.supplier_name||"")}</p>
<p><b>Manufacturer Part Number:</b> ${escapeHtml(p.manufacturer_part_number||"")}</p>
<p><b>Part Type:</b> ${escapeHtml(p.part_type||"")}</p>
${p.description?`<p><b>Description:</b> ${escapeHtml(p.description)}</p>`:""}
${p.area?`<p><b>Area:</b> ${escapeHtml(p.area)}</p>`:""}
<p><b>Current Qty:</b> ${qty(p)}</p>
<button onclick="selectMovementPart('${encoded}')">${selected?'Selected':'Select This Part'}</button>
</div>`;
}).join(""):`<div class="card"><p>No matching parts found.</p></div>`;
}

function selectMovementPart(encoded){
selectedMovementPart=decodePart(encoded);

document.getElementById("selectedMovePart").className="card selected-stock";

document.getElementById("selectedMovePart").innerHTML=`
<h2>${escapeHtml(selectedMovementPart.part_name||"")}</h2>
<p><b>Supplier / Manufacturer:</b> ${escapeHtml(selectedMovementPart.supplier_name||"")}</p>
<p><b>Manufacturer Part Number:</b> ${escapeHtml(selectedMovementPart.manufacturer_part_number||"")}</p>
<p><b>Part Type:</b> ${escapeHtml(selectedMovementPart.part_type||"")}</p>
${selectedMovementPart.description?`<p><b>Description:</b> ${escapeHtml(selectedMovementPart.description)}</p>`:""}
${selectedMovementPart.area?`<p><b>Area:</b> ${escapeHtml(selectedMovementPart.area)}</p>`:""}
<p><b>Current Quantity:</b> ${qty(selectedMovementPart)}</p>
<p class="location">
${selectedMovementPart.rack?"Rack "+escapeHtml(selectedMovementPart.rack):""}
${selectedMovementPart.shelf?" | Shelf "+escapeHtml(selectedMovementPart.shelf):""}
${selectedMovementPart.drawer?" | Drawer "+escapeHtml(selectedMovementPart.drawer):""}
</p>`;

document.getElementById("moveQty").focus();

showMovementSearchResults();
}

async function submitMovement(){
const p=selectedMovementPart;
const type=document.getElementById("moveType").value;
const amount=Number(document.getElementById("moveQty").value||0);
const job=document.getElementById("moveJob").value.trim();
const notes=document.getElementById("moveNotes").value.trim();

if(!p||!Number.isInteger(amount)||amount<1){
alert("Select a part and enter a whole-number quantity greater than zero.");
return;
}
if(type==="OUT"&&amount>qty(p)){
alert("There is not enough stock for this movement.");
return;
}
if(job.length>100||notes.length>1000){
alert("The job reference or notes are too long.");
return;
}

const newQty=type==="IN"?qty(p)+amount:qty(p)-amount;
setButtonBusy("movementSubmitButton",true,"Saving...","Submit Movement");
const saved=await changeQuantity(p,newQty,type,job,notes);
setButtonBusy("movementSubmitButton",false,"Saving...","Submit Movement");
if(!saved)return;

document.getElementById("moveQty").value="";
document.getElementById("moveJob").value="";
document.getElementById("moveNotes").value="";
setAppStatus("Movement saved.","success");
}

function showBulkSearchResults(){
const box=document.getElementById("bulkSearchResults");
if(!box)return;

const s=(document.getElementById("bulkSearch")?.value||"").toLowerCase();

if(!s){
box.innerHTML=`<div class="card"><p>Start typing to search parts.</p></div>`;
return;
}

const matches=allParts.filter(p=>partMatches(p,s)).slice(0,20);

box.innerHTML=matches.length?matches.map(p=>{
const encoded=encodePart(p);

return `
<div class="card">
<h2>${escapeHtml(p.part_name||"")}</h2>
<p><b>Supplier / Manufacturer:</b> ${escapeHtml(p.supplier_name||"")}</p>
<p><b>Part Code:</b> ${escapeHtml(p.manufacturer_part_number||"")}</p>
<p><b>Current Qty:</b> ${qty(p)}</p>
<p class="location">
${p.rack?"Rack "+escapeHtml(p.rack):""}
${p.shelf?" | Shelf "+escapeHtml(p.shelf):""}
${p.drawer?" | Drawer "+escapeHtml(p.drawer):""}
</p>
<button onclick="addToBulkJob('${encoded}')">Add to Job</button>
</div>`;
}).join(""):`<div class="card"><p>No matching parts found.</p></div>`;
}

function addToBulkJob(encoded){
const part=decodePart(encoded);

const exists=bulkItems.find(item=>item.part.id===part.id);

if(exists){
alert("This part is already in the job table.");
return;
}

bulkItems.push({
part:part,
amount:1
});

renderBulkTable();
}

function renderBulkTable(){
const box=document.getElementById("bulkJobTable");
if(!box)return;

if(bulkItems.length===0){
box.innerHTML=`<div class="card"><p>No parts added to this job yet.</p></div>`;
return;
}

box.innerHTML=`
<div class="table-wrap">
<table>
<caption class="sr-only">Parts added to the current job</caption>
<thead>
<tr>
<th scope="col">Part</th>
<th scope="col">Part Code</th>
<th scope="col">Stock</th>
<th scope="col">Qty Used</th>
<th scope="col">Remove</th>
</tr>
</thead>
<tbody>
${bulkItems.map((item,i)=>`
<tr>
<td>${escapeHtml(item.part.part_name||"")}</td>
<td>${escapeHtml(item.part.manufacturer_part_number||"")}</td>
<td>${qty(item.part)}</td>
<td><label class="sr-only" for="bulkAmount-${i}">Quantity used for ${escapeHtml(item.part.part_name||"part")}</label><input id="bulkAmount-${i}" type="number" min="1" step="1" value="${item.amount}" oninput="updateBulkAmount(${i},this.value)"></td>
<td><button onclick="removeBulkItem(${i})">Remove</button></td>
</tr>
`).join("")}
</tbody>
</table>
</div>`;
}

function updateBulkAmount(index,value){
bulkItems[index].amount=Number(value||0);
}

function removeBulkItem(index){
bulkItems.splice(index,1);
renderBulkTable();
}

function clearBulkJob(){
bulkItems=[];
document.getElementById("bulkSearch").value="";
document.getElementById("bulkJob").value="";
document.getElementById("bulkNotes").value="";
renderBulkTable();
showBulkSearchResults();
}

async function submitBulkIssue(){
const job=document.getElementById("bulkJob").value.trim();
const notes=document.getElementById("bulkNotes").value.trim();

if(!job){
alert("Enter a job number");
return;
}

if(bulkItems.length===0){
alert("Add at least one part to the job table.");
return;
}

const itemsToProcess=bulkItems.map((item,i)=>{
const input=document.getElementById("bulkAmount-"+i);
const amount=Number(input ? input.value : item.amount || 0);
return {
part_id:item.part.id,
quantity:amount,
available:qty(item.part)
};
});

if(itemsToProcess.some(item=>!item.part_id||!Number.isInteger(item.quantity)||item.quantity<1)){
alert("Every row needs a whole-number quantity greater than zero.");
return;
}
if(itemsToProcess.some(item=>item.quantity>item.available)){
alert("One or more rows request more stock than is available.");
return;
}
if(job.length>100||notes.length>1000){
alert("The job number or notes are too long.");
return;
}

setButtonBusy("bulkSubmitButton",true,"Saving...","Submit Bulk Issue");
try{
await callRpc("inventory_bulk_issue",{
p_job_number:job,
p_notes:notes,
p_items:itemsToProcess.map(({part_id,quantity})=>({part_id,quantity}))
});
await loadParts();

bulkItems=[];
document.getElementById("bulkSearch").value="";
document.getElementById("bulkJob").value="";
document.getElementById("bulkNotes").value="";
renderBulkTable();
setAppStatus("Bulk job issue saved.","success");
showPage("historyPage");
}catch(error){
showActionError(error);
}finally{
setButtonBusy("bulkSubmitButton",false,"Saving...","Submit Bulk Issue");
}
}
async function loadMovements(){
try{
const data=await apiJson(MOVEMENT_API+"?select=*&order=created_at.desc&limit=1000");
movements=Array.isArray(data)?data:[];
dashboardMovementsLoaded=true;
populateHistoryFilters();
showHistory();
renderDashboard();
}catch(error){
showActionError(error);
}
}

function getPartForMovement(m){
return allParts.find(p=>
(p.id&&m.part_id&&p.id===m.part_id) ||
(p.manufacturer_part_number&&m.manufacturer_part_number&&p.manufacturer_part_number===m.manufacturer_part_number)
)||{};
}

function uniqueSorted(values){
return [...new Set(values.filter(Boolean))].sort();
}

function populateHistoryFilter(id,placeholder,values){
document.getElementById(id).innerHTML=
`<option value="">${placeholder}</option>`+
uniqueSorted(values).map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
}

function populateHistoryFilters(){
populateHistoryFilter("historySupplierFilter","All Suppliers / Manufacturers",allParts.map(p=>p.supplier_name));
populateHistoryFilter("historyPartTypeFilter","All Part Types",allParts.map(p=>p.part_type));
populateHistoryFilter("historyJobFilter","All Job Numbers",movements.map(m=>m.job_number));
}

function filteredHistoryResults(){
const search=(document.getElementById("historySearch")?.value||"").toLowerCase();
const typeFilter=document.getElementById("historyTypeFilter")?.value||"";
const supplierFilter=document.getElementById("historySupplierFilter")?.value||"";
const partTypeFilter=document.getElementById("historyPartTypeFilter")?.value||"";
const jobFilter=document.getElementById("historyJobFilter")?.value||"";
const dateFrom=document.getElementById("historyDateFrom")?.value||"";
const dateTo=document.getElementById("historyDateTo")?.value||"";

return movements.filter(m=>{
const p=getPartForMovement(m);

const combined={
...m,
supplier_name:p.supplier_name||"",
part_type:p.part_type||"",
description:p.description||"",
rack:p.rack||"",
shelf:p.shelf||"",
drawer:p.drawer||"",
area:p.area||""
};

if(search&&!JSON.stringify(combined).toLowerCase().includes(search))return false;
if(typeFilter&&m.movement_type!==typeFilter)return false;
if(supplierFilter&&p.supplier_name!==supplierFilter)return false;
if(partTypeFilter&&p.part_type!==partTypeFilter)return false;
if(jobFilter&&m.job_number!==jobFilter)return false;
const movementTime=new Date(m.created_at).getTime();
if(dateFrom&&movementTime<new Date(dateFrom+'T00:00:00').getTime())return false;
if(dateTo&&movementTime>new Date(dateTo+'T23:59:59.999').getTime())return false;

return true;
});
}

function showHistory(){
const list=filteredHistoryResults();
const reversedIds=new Set(movements.map(movement=>movement.reversed_movement_id).filter(Boolean));
const stockIn=list.filter(movement=>String(movement.movement_type||'').endsWith('IN')).reduce((sum,movement)=>sum+Number(movement.quantity||0),0);
const stockOut=list.filter(movement=>String(movement.movement_type||'').endsWith('OUT')).reduce((sum,movement)=>sum+Number(movement.quantity||0),0);
setText('historySummary',`${list.length} movement${list.length===1?'':'s'} · ${stockIn} units in · ${stockOut} units out`);

document.getElementById("historyResults").innerHTML=list.map(m=>{
const p=getPartForMovement(m);
const reversed=reversedIds.has(m.id);

return `
<div class="card">
<h2>${escapeHtml(m.part_name||"")}</h2>
<p><b>Manufacturer Part Number:</b> ${escapeHtml(m.manufacturer_part_number||"")}</p>
<p><b>Supplier / Manufacturer:</b> ${escapeHtml(p.supplier_name||"")}</p>
<p><b>Part Type:</b> ${escapeHtml(p.part_type||"")}</p>
${p.description?`<p><b>Description:</b> ${escapeHtml(p.description)}</p>`:""}
${p.area?`<p><b>Area:</b> ${escapeHtml(p.area)}</p>`:""}
<p><b>Movement:</b> ${escapeHtml(m.movement_type||"")}</p>
<p><b>Quantity:</b> ${escapeHtml(m.quantity||"")}</p>
<p><b>Job:</b> ${escapeHtml(m.job_number||"")}</p>
<p><b>Notes:</b> ${escapeHtml(m.notes||"")}</p>
${m.performed_by?`<p><b>Performed by:</b> ${escapeHtml(m.performed_by)}</p>`:""}
${m.reversed_movement_id?`<p><b>Reverses movement:</b> #${escapeHtml(m.reversed_movement_id)}</p>`:""}
<p class="location">
${p.rack?"Rack "+escapeHtml(p.rack):""}
${p.shelf?" | Shelf "+escapeHtml(p.shelf):""}
${p.drawer?" | Drawer "+escapeHtml(p.drawer):""}
</p>
<p class="small">${escapeHtml(formatDate(m.created_at))}</p>
${m.movement_type!=="REVERSAL"&&!reversed?`<button onclick="reverseMovement(${m.id})">Correct / reverse movement</button>`:""}
${reversed?'<span class="stock-badge manual">Reversed</span>':""}
</div>`;
}).join("");
}

function clearHistoryFilters(){
document.getElementById("historySearch").value="";
document.getElementById("historyTypeFilter").value="";
document.getElementById("historySupplierFilter").value="";
document.getElementById("historyPartTypeFilter").value="";
document.getElementById("historyJobFilter").value="";
document.getElementById("historyDateFrom").value="";
document.getElementById("historyDateTo").value="";

showHistory();
}

function exportHistoryToExcel(){
const filtered=filteredHistoryResults();

let csv="Date,Part Name,Manufacturer Part Number,Supplier,Part Type,Description,Movement,Quantity,Job Number,Movement Notes,Performed By,Reversed Movement,Rack,Shelf,Drawer,Area\n";

filtered.forEach(m=>{
const p=getPartForMovement(m);

csv += [
m.created_at||"",
m.part_name||"",
m.manufacturer_part_number||"",
p.supplier_name||"",
p.part_type||"",
p.description||"",
m.movement_type||"",
m.quantity||"",
m.job_number||"",
m.notes||"",
m.performed_by||"",
m.reversed_movement_id||"",
p.rack||"",
p.shelf||"",
p.drawer||"",
p.area||""
].map(csvCell).join(",")+"\n";
});

downloadCsv("stock_movement_history.csv",csv);
}

async function reverseMovement(movementId){
const movement=movements.find(item=>item.id===movementId);
if(!movement)return;
const reason=await requestText('Correct stock movement',`Explain why movement #${movementId} for ${movement.part_name||'this part'} should be reversed.`);
if(!reason)return;
try{
await callRpc('inventory_reverse_movement',{p_movement_id:movementId,p_reason:reason});
await loadParts();
await loadMovements();
setAppStatus('The movement was reversed and a correction was added to history.','success');
}catch(error){showActionError(error);}
}

function csvCell(value){
let text=String(value??"");
if(/^[=+\-@]/.test(text))text="'"+text;
return `"${text.replace(/"/g,'""')}"`;
}

function formatDate(value){
if(!value)return "";
const date=new Date(value);
return Number.isNaN(date.getTime())?String(value):date.toLocaleString("en-GB");
}

function clearHighlights(){
document.querySelectorAll(".highlight").forEach(e=>e.classList.remove("highlight"));
}

function extractNumber(v){
const m=String(v||"").match(/\d+/);
return m?m[0]:"";
}

function showMap(rack,shelf,drawer){
showPage("mapPage");
clearHighlights();

const rackNum=extractNumber(rack);
const shelfNum=extractNumber(shelf);
const drawerRaw=String(drawer||"").trim();
const drawerText=drawerRaw.toLowerCase();
const drawerNum=extractNumber(drawerText);

document.getElementById("selectedInfo").innerHTML=
`<div class="card">
<b>Selected Location</b><br>
${rackNum?"Rack "+rackNum+" ":""}
${shelfNum?"Shelf "+shelfNum+" ":""}
${drawerRaw?"Drawer "+escapeHtml(drawerRaw):""}
</div>`;

document.getElementById("rack-"+rackNum)?.classList.add("highlight");
document.getElementById("shelf-"+shelfNum)?.classList.add("highlight");

if(drawerText.startsWith("l")&&drawerNum){
document.getElementById("left-drawer-main")?.classList.add("highlight");
document.getElementById("left-drawer-"+drawerNum)?.classList.add("highlight");
}

if(drawerText.startsWith("r")&&drawerNum){
document.getElementById("right-drawer-main")?.classList.add("highlight");
document.getElementById("right-drawer-"+drawerNum)?.classList.add("highlight");
}
}

function showMapFromEncoded(encoded){
const location=JSON.parse(decodeURIComponent(encoded));
showMap(location.rack,location.shelf,location.drawer);
}

async function loadDashboardMovements(){
if(dashboardMovementsLoaded)return;
dashboardMovementsLoaded=true;
try{
const data=await apiJson(MOVEMENT_API+'?select=*&order=created_at.desc&limit=5');
movements=Array.isArray(data)?data:[];
renderDashboard();
}catch(error){
dashboardMovementsLoaded=false;
console.error(error);
}
}

function renderDashboard(){
const stats=document.getElementById('dashboardStats');
if(!stats)return;
const low=allParts.filter(isPartLow);
const out=allParts.filter(part=>qty(part)<=0);
const totalUnits=allParts.reduce((sum,part)=>sum+qty(part),0);
stats.innerHTML=`
<div class="stat-card"><span>Total parts</span><strong>${allParts.length}</strong></div>
<div class="stat-card success"><span>Total units</span><strong>${totalUnits}</strong></div>
<div class="stat-card warning"><span>Low stock</span><strong>${low.length}</strong></div>
<div class="stat-card warning"><span>Out of stock</span><strong>${out.length}</strong></div>`;
const lowBox=document.getElementById('dashboardLowStock');
lowBox.innerHTML=low.length?low.slice(0,5).map(part=>`<div class="duplicate-record"><b>${escapeHtml(part.part_name||'')}</b><br><span class="small">${qty(part)} available · ${escapeHtml(part.supplier_name||'No supplier')}${part.manually_low?' · Manually marked':''}</span></div>`).join(''):'<div class="empty-state"><p>No low-stock parts.</p></div>';
const movementBox=document.getElementById('dashboardMovements');
movementBox.innerHTML=movements.length?movements.slice(0,5).map(movement=>`<div class="duplicate-record"><b>${escapeHtml(movement.part_name||'')}</b><br><span class="small">${escapeHtml(movement.movement_type||'')} · ${escapeHtml(movement.quantity||'')} · ${escapeHtml(formatDate(movement.created_at))}${movement.performed_by?' · '+escapeHtml(movement.performed_by):''}</span></div>`).join(''):'<div class="empty-state"><p>No recent movements.</p></div>';
loadDashboardMovements();
}

function suggestedReorderQuantity(part){
const saved=Number(part.reorder_quantity);
if(Number.isInteger(saved)&&saved>0)return saved;
return Math.max(1,getWarningLevel(part.part_type)*2-qty(part));
}

function renderReorderList(){
const box=document.getElementById('reorderResults');
if(!box)return;
const low=allParts.filter(isPartLow).sort((a,b)=>String(a.supplier_name||'').localeCompare(String(b.supplier_name||''))||String(a.part_name||'').localeCompare(String(b.part_name||'')));
if(!low.length){box.innerHTML='<div class="empty-state"><h3>Nothing to reorder</h3><p>No parts are below their warning level or manually marked low.</p></div>';return;}
const groups=low.reduce((result,part)=>{const key=part.supplier_name||'No supplier';(result[key]??=[]).push(part);return result;},{});
box.innerHTML=Object.entries(groups).map(([supplier,parts])=>`<section class="supplier-group"><h3>${escapeHtml(supplier)}</h3><div class="table-wrap"><table><thead><tr><th scope="col">Part</th><th scope="col">Code</th><th scope="col">Available</th><th scope="col">Suggested order</th><th scope="col">Reference</th></tr></thead><tbody>${parts.map(part=>`<tr><td>${escapeHtml(part.part_name||'')}${part.manually_low?' <span class="stock-badge manual">Manual</span>':''}</td><td>${escapeHtml(part.manufacturer_part_number||'')}</td><td>${qty(part)}</td><td><label class="sr-only" for="reorder-${part.id}">Suggested order quantity for ${escapeHtml(part.part_name||'part')}</label><input class="reorder-quantity" id="reorder-${part.id}" type="number" min="0" step="1" value="${suggestedReorderQuantity(part)}" onchange="updateReorderQuantity(${part.id},this.value)"></td><td>${safeExternalUrl(part.supplier_url)?`<a href="${escapeHtml(safeExternalUrl(part.supplier_url))}" target="_blank" rel="noopener noreferrer">Supplier page</a>`:'—'}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
}

async function updateReorderQuantity(partId,value){
const part=allParts.find(item=>item.id===partId);
const quantity=Number(value);
if(!part||!Number.isInteger(quantity)||quantity<0){showActionError(new Error('Enter a whole-number reorder quantity of zero or more.'));return;}
try{
const rows=await apiJson(getPartMutationUrl(part,true),{method:'PATCH',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({reorder_quantity:quantity})});
if(Array.isArray(rows)&&rows.length===0)throw new Error('This part changed in another session. Refresh and try again.');
await loadParts();
setAppStatus('Reorder quantity saved.','success');
}catch(error){showActionError(error);}
}

function exportReorderList(){
const parts=allParts.filter(isPartLow);
let csv='Supplier,Part Name,Manufacturer Part Number,Available,Suggested Order,Manually Marked,Supplier URL\n';
parts.forEach(part=>{csv+=[part.supplier_name,part.part_name,part.manufacturer_part_number,qty(part),suggestedReorderQuantity(part),part.manually_low?'Yes':'No',part.supplier_url].map(csvCell).join(',')+'\n';});
downloadCsv('parts-reorder-list.csv',csv);
}

function renderDuplicateReview(){
const box=document.getElementById('duplicateResults');
if(!box)return;
const groups=new Map();
allParts.forEach(part=>{
const key=String(part.manufacturer_part_number||'').trim().toLowerCase();
if(!key)return;
if(!groups.has(key))groups.set(key,[]);
groups.get(key).push(part);
});
const duplicates=[...groups.values()].filter(group=>group.length>1);
if(!duplicates.length){
box.innerHTML='<div class="empty-state"><h3>No duplicate part numbers</h3><p>Every populated manufacturer part number is unique.</p></div>';
return;
}
box.innerHTML=duplicates.map(group=>`<section class="card duplicate-group"><h3>${escapeHtml(group[0].manufacturer_part_number)}</h3>${group.map(part=>`<div class="duplicate-record"><b>${escapeHtml(part.part_name||'')}</b> · Qty ${qty(part)} · ${escapeHtml(part.supplier_name||'No supplier')}<br><button onclick="mergeDuplicateGroup('${encodeInlineValue(group[0].manufacturer_part_number)}',${part.id})">Keep this record and merge the others</button></div>`).join('')}</section>`).join('');
}

async function mergeDuplicateGroup(encodedPartNumber,keepId){
const partNumber=decodeURIComponent(encodedPartNumber);
const group=allParts.filter(part=>String(part.manufacturer_part_number||'').toLowerCase()===partNumber.toLowerCase());
const keep=group.find(part=>part.id===keepId);
const mergeIds=group.filter(part=>part.id!==keepId).map(part=>part.id);
if(!keep||!mergeIds.length)return;
if(!await confirmAction('Merge duplicate parts',`Keep ${keep.part_name} and merge ${mergeIds.length} other record${mergeIds.length===1?'':'s'} into it? Quantities and movement history will be combined.`,'Merge records'))return;
try{
await callRpc('inventory_merge_parts',{p_keep_id:keepId,p_merge_ids:mergeIds});
await loadParts();
renderDuplicateReview();
setAppStatus('Duplicate records merged.','success');
}catch(error){showActionError(error);}
}

function getBulkTemplates(){
try{return JSON.parse(localStorage.getItem(BULK_TEMPLATE_KEY)||'[]');}catch{return [];}
}

function populateBulkTemplates(){
const select=document.getElementById('bulkTemplateSelect');
if(!select)return;
const selected=select.value;
select.innerHTML='<option value="">Choose a template</option>'+getBulkTemplates().map(template=>`<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`).join('');
select.value=selected;
}

function saveBulkTemplate(){
const name=fieldValue('bulkTemplateName');
if(!name||!bulkItems.length){alert('Enter a template name and add at least one part.');return;}
const templates=getBulkTemplates();
templates.push({id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),name,items:bulkItems.map(item=>({partId:item.part.id,amount:Number(item.amount)||1}))});
localStorage.setItem(BULK_TEMPLATE_KEY,JSON.stringify(templates.slice(-30)));
setFieldValues({bulkTemplateName:''});
populateBulkTemplates();
setAppStatus('Bulk template saved.','success');
}

function loadBulkTemplate(){
const id=document.getElementById('bulkTemplateSelect')?.value;
const template=getBulkTemplates().find(item=>item.id===id);
if(!template)return;
bulkItems=template.items.map(item=>({part:allParts.find(part=>part.id===item.partId),amount:item.amount})).filter(item=>item.part);
renderBulkTable();
setAppStatus('Bulk template loaded.','success');
}

async function deleteBulkTemplate(){
const id=document.getElementById('bulkTemplateSelect')?.value;
if(!id)return;
if(!await confirmAction('Delete template','Delete the selected bulk-job template?','Delete'))return;
localStorage.setItem(BULK_TEMPLATE_KEY,JSON.stringify(getBulkTemplates().filter(item=>item.id!==id)));
populateBulkTemplates();
}

function confirmAction(title,message,acceptLabel='Confirm'){
const dialog=document.getElementById('confirmDialog');
if(!dialog?.showModal)return Promise.resolve(confirm(message));
setText('confirmTitle',title);
setText('confirmMessage',message);
setText('confirmAcceptButton',acceptLabel);
return new Promise(resolve=>{
dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});
dialog.showModal();
});
}

function requestText(title,message){
const dialog=document.getElementById('textInputDialog');
if(!dialog?.showModal){
const value=prompt(message);
return Promise.resolve(value?.trim()||'');
}
setText('textInputTitle',title);
setText('textInputMessage',message);
const input=document.getElementById('textInputValue');
input.value='';
return new Promise(resolve=>{
dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'?input.value.trim():''),{once:true});
dialog.showModal();
input.focus();
});
}

function changeMapZoom(change){
const container=document.querySelector('.map-container');
if(!container)return;
const current=Number(container.dataset.zoom)||(matchMedia('(max-width: 700px)').matches ? 0.31 : 1);
const next=Math.min(1.5,Math.max(.2,current+change));
container.dataset.zoom=String(next);
container.style.setProperty('--map-zoom',String(next));
}

function resetMapZoom(){
const container=document.querySelector('.map-container');
if(!container)return;
const zoom=matchMedia('(max-width: 700px)').matches ? 0.31 : 1;
container.dataset.zoom=String(zoom);
container.style.setProperty('--map-zoom',String(zoom));
}

async function openScanner(){
const dialog=document.getElementById('scannerDialog');
if(!dialog)return;
dialog.showModal();
setText('scannerStatus','Starting camera…');
if(!window.BarcodeDetector||!navigator.mediaDevices?.getUserMedia){
setText('scannerStatus','Camera scanning is not supported here. Enter the code manually below.');
return;
}
try{
scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
const video=document.getElementById('scannerVideo');
video.srcObject=scannerStream;
await video.play();
setText('scannerStatus','Point the camera at a barcode or QR code.');
const detector=new BarcodeDetector({formats:['code_128','code_39','ean_13','ean_8','qr_code','data_matrix']});
const scan=async()=>{
if(!scannerStream)return;
try{
const codes=await detector.detect(video);
if(codes[0]?.rawValue){applyScannedCode(codes[0].rawValue);return;}
}catch(error){console.error(error);}
scannerFrame=requestAnimationFrame(scan);
};
scan();
}catch(error){
console.error(error);
setText('scannerStatus','Camera access was unavailable. Enter the code manually below.');
}
}

function closeScanner(){
cancelAnimationFrame(scannerFrame);
scannerStream?.getTracks().forEach(track=>track.stop());
scannerStream=null;
const dialog=document.getElementById('scannerDialog');
if(dialog?.open)dialog.close();
}

function applyScannedCode(code){
closeScanner();
showPage('searchPage');
const search=document.getElementById('search');
search.value=String(code||'').trim();
searchParts();
setAppStatus(`Showing results for scanned code ${search.value}.`,'success');
}

function useScannerFallback(){
const code=fieldValue('scannerFallback');
if(code)applyScannedCode(code);
}

function downloadCsv(filename,content){
const blob=new Blob([content],{type:'text/csv;charset=utf-8'});
const url=URL.createObjectURL(blob);
const link=document.createElement('a');
link.href=url;
link.download=filename;
link.click();
URL.revokeObjectURL(url);
}

function parseCsv(text){
const rows=[];
let row=[];
let cell='';
let quoted=false;
for(let index=0;index<text.length;index++){
const character=text[index];
if(quoted){
if(character==='"'&&text[index+1]==='"'){cell+='"';index++;}
else if(character==='"')quoted=false;
else cell+=character;
}else if(character==='"')quoted=true;
else if(character===','){row.push(cell);cell='';}
else if(character==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
else cell+=character;
}
if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
return rows.filter(values=>values.some(value=>String(value).trim()!==''));
}

function normaliseCsvHeader(value){
return String(value||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
}

function importValues(record){
const value=(...names)=>{
for(const name of names){const found=record[normaliseCsvHeader(name)];if(found!==undefined)return String(found).trim();}
return '';
};
const shelf=value('Shelf');
const reorder=value('Reorder Quantity','Suggested Reorder Quantity');
const price=value('Purchase Price','Price');
return {
name:value('Part Name','Name'),supplier:value('Supplier Name','Supplier','Manufacturer'),mpn:value('Manufacturer Part Number','Part Number','Part Code'),type:value('Part Type','Type'),description:value('Description'),rack:value('Rack'),shelf:shelf===''?null:Number(shelf),drawer:value('Drawer'),area:value('Area'),quantity:Number(value('Quantity','Qty')||0),manuallyLow:/^(1|true|yes|y|low)$/i.test(value('Manually Low','Manual Low')),reorderQuantity:reorder===''?null:Number(reorder),supplierUrl:value('Supplier URL','Supplier Page'),datasheetUrl:value('Datasheet URL','Datasheet'),imageUrl:value('Image URL','Image'),purchasePrice:price===''?null:Number(price)
};
}

async function previewCsvImport(event){
const file=event.target.files?.[0];
if(!file){resetImportPage();return;}
try{
const rows=parseCsv(await file.text());
if(rows.length<2)throw new Error('The CSV must contain a header row and at least one part.');
const headers=rows[0].map(normaliseCsvHeader);
if(!headers.includes('partname')&&!headers.includes('name'))throw new Error('The CSV needs a Part Name column.');
const seen=new Set(allParts.map(part=>String(part.manufacturer_part_number||'').trim().toLowerCase()).filter(Boolean));
csvImportRows=rows.slice(1,501).map((values,index)=>{
const record={};
headers.forEach((header,column)=>record[header]=values[column]??'');
const part=importValues(record);
let error=validatePartValues(part);
const key=part.mpn.toLowerCase();
const duplicate=Boolean(key&&seen.has(key));
if(key)seen.add(key);
if(duplicate)error=error||'Duplicate manufacturer part number';
return {line:index+2,part,error,duplicate};
});
renderCsvImportPreview();
}catch(error){
csvImportRows=[];
showActionError(error);
renderCsvImportPreview();
}
}

function renderCsvImportPreview(){
const preview=document.getElementById('csvImportPreview');
const button=document.getElementById('csvImportButton');
if(!preview||!button)return;
const valid=csvImportRows.filter(row=>!row.error);
const invalid=csvImportRows.length-valid.length;
setText('csvImportSummary',csvImportRows.length?`${valid.length} valid row${valid.length===1?'':'s'} · ${invalid} skipped row${invalid===1?'':'s'}`:'Choose a CSV file to preview it before importing.');
button.disabled=valid.length===0;
if(!csvImportRows.length){preview.innerHTML='';return;}
preview.innerHTML=`<div class="table-wrap"><table><caption class="sr-only">CSV import preview</caption><thead><tr><th scope="col">Line</th><th scope="col">Part</th><th scope="col">Code</th><th scope="col">Quantity</th><th scope="col">Status</th></tr></thead><tbody>${csvImportRows.slice(0,100).map(row=>`<tr><td>${row.line}</td><td>${escapeHtml(row.part.name)}</td><td>${escapeHtml(row.part.mpn)}</td><td>${escapeHtml(row.part.quantity)}</td><td class="${row.error?'validation-error':'validation-ok'}">${escapeHtml(row.error||'Ready')}</td></tr>`).join('')}</tbody></table></div>${csvImportRows.length>100?'<p class="small">Showing the first 100 preview rows.</p>':''}`;
}

async function commitCsvImport(){
const valid=csvImportRows.filter(row=>!row.error);
if(!valid.length)return;
if(!await confirmAction('Import parts',`Add ${valid.length} validated part${valid.length===1?'':'s'} to the inventory?`,'Import'))return;
setButtonBusy('csvImportButton',true,'Importing…','Import valid rows');
try{
await apiRequest(TABLE_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(valid.map(row=>partPayload(row.part)))});
await loadParts();
resetImportPage();
setAppStatus(`${valid.length} part${valid.length===1?'':'s'} imported.`,'success');
showPage('searchPage');
}catch(error){showActionError(error);}
finally{setButtonBusy('csvImportButton',false,'Importing…','Import valid rows');}
}

function resetImportPage(){
csvImportRows=[];
const file=document.getElementById('csvImportFile');
if(file)file.value='';
renderCsvImportPreview();
}

function downloadImportTemplate(){
downloadCsv('parts-import-template.csv','Part Name,Supplier Name,Manufacturer Part Number,Part Type,Description,Rack,Shelf,Drawer,Area,Quantity,Manually Low,Reorder Quantity,Supplier URL,Datasheet URL,Image URL,Purchase Price\n');
}

window.addEventListener("load",restoreStaffSession);
