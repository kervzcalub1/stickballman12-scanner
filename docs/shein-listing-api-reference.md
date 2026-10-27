# SHEIN Open API — the LISTING side (publish, attributes, sizes, review)

Pulled 2026-10-27 from the public doc portal, same way as `docs/shein-api-reference.md` (stock/price/orders).
Field descriptions are SHEIN's own (Chinese). Re-pull: `GET https://open.sheincorp.com/api/api/apiDoc/queryApiPublishDocDetailInfoById?id=<docId>&isLatest=true`.

## Custom size values — the NEW scheme (required for apps created after 2025-12-01, i.e. ours)

Guide page: `POST https://open.sheincorp.com/api/page/detail?pageId=a0f9bf6a-bc89-4a6d-a25f-385cca93f866` (body `{}`). Its text, curl samples removed:

```
销售属性的自定义属性值新方案
适用范围
适用的应用类型：自运营、半托管、全托管、POP
上述类型的应用均可使用新方案
2025年12月1日后创建的应用，必须使用新方案
2025年12月1日前创建的旧应用，可按需对接新方案
新旧方案对比
对比项 | 旧方案 | 新方案 | 
数据结构 | 销售属性的自定义属性值和分类绑定。
自定义属性值【例如：小码】如果想在多个分类下使用，则需在每个分类下创建attribute value id，然后一一对应放在对应分类下使用。
 | 销售属性的自定义属性值和分类解绑，和商家绑定
自定义属性值【例如小码】创建一次后，可以在多个分类下使用。
 | 
接口调用流程 | 场景1：创建新的自定义属性值
查询商家的分类A下有哪些销售属性支持自定义属性值
→ 若支持，则在分类A下，为可自定义的属性创建自定义属性值，获取attribute_value_id
→ 发布/编辑分类A的商品时，在销售属性中下入参attribute_value_id
场景2：使用已创建的自定义属性值
查询店内全量可用属性值
→ 找到is_custom_attribute_value=true的attribute_value_id
→ 发布/编辑商品时，销售属性中入参获取的attribute_value_id | 场景1：创建新的自定义属性值
查询商家的分类A下有哪些销售属性支持自定义属性值
→ 若支持，则发布/编辑分类A的商品时，可自定义的销售属性中入参自定义属性值的custom_attribute_value即可，不需要attribute_value_id
场景2：使用已创建的自定义属性值
和场景1相同的操作流程。
系统会对所有自定义属性值去重，即内容一致代表是同一个自定义属性值；且自定义属性值和分类不再关联。只要分类可自定义属性值，就可用店内所有自定义属性值。 | 
商家自定义属性值数量上限 | 1万 | 3万 | 
优劣 | 劣势：商家可用自定义属性值数量少；查询可用属性接口速度慢 | 优势：商家可用自定义属性值数量增加；查询可用属性接口速度加快 | 
新方案对接方式
1 对接流程
2025年12月1日前创建的应用，在新方案对接完成后，需要联系开放平台，告知上线的应用ID和上线时间。开放平台需要将您的应用进行配置，以确保使用应用的商家全部切换至新方案中。
2 接入说明
第1步：查询销售属性是否支持自定义属性值【重要】
平台对于自定义属性值的功能管控颗粒度是【商家+分类+属性】，必须按此逻辑确认属性是否支持自定义属性值。
例如商家1和商家2，均可使用分类A，；分类A下有两个销售属性，S1和S2。在平台的管控下可能出现以下情况
商家1的分类A下的销售属性S1可自定义属性值，S2不可以
商家2的分类A下，S1和S2都不可以自定义属性值
请通过此接口来确认属性是否可自定义：/open-api/goods/get-custom-attribute-permission-config
"has_permission": 1，代表支持自定义属性值
Example
--data-raw '{
 "category_id_list": [
 20039881
 ]
}'
----------------------------------------------------------------------------
响应
{
 "code": "0",
 "msg": "OK",
 "info": {
 "data": [
 {
 "has_permission": 1,
 "last_category_id": 20039881,
 "attribute_id": 2147484187
 },
 {
 "has_permission": 1,
 "last_category_id": 20039881,
 "attribute_id": 2147484186
 }
 ],
 "meta": {
 "count": 2,
 "customObj": null
 }
 },
 "bbl": null,
 "traceId": "84de1e85727ee683"
}
第2步：发布/编辑商品时通过custom_attribute_value字段创建自定义属性值
发布/编辑商品接口：/open-api/goods/product/publishOrEdit
只有支持自定义属性值的销售属性，可以通过发布接口中custom_attribute_value字段创建自定义属性值。发布接口中涉及自定义属性值的入参字段（红色加粗）见下表，表格下方有请求、响应示例
​字段名 | 字段名 | 字段名 | 字段名 | ​字段类型 | 是否必填 | 字段描述 | 
skc_list | | | | object[] | 是 | skc列表 | 
 | sale_attribute | | | | 是 | skc销售属性 | 
 | | attribute_id | | int64 | 是 | 销售属性ID | 
 | | attribute_value_id | | int64 | 否 | 销售属性值ID（平台提供值/通过添加自定义属性接口获取的值） | 
 | | custom_attribute_value | | string | 否 | 商家的自定义销售属性值。
仅在销售属性ID支持自定义属性值时，才可在此字段内入参。
属性值要求：字符数50以内；支持半角符号，不可输入全角符号；不支持unicode，检验表达式可参考：String emojiPattern = "[\\uD83C-\\uDBFF\\uDC00-\\uDFFF\\u2600-\\u27ff]" | 
 | | ​language | | string | 否 | 自定义属性值的语种。
支持的语种：en、zh-cn、fr、es、it。如果ERP不传多语言内容，平台会做系统翻译。 | 
 | sku_list | ​ | | object[] | 是 | sku列表 | 
 | | ​sale_attribute_list | | object[] | 是 | 销售属性列表 | 
 | | ​ | attribute_id | int64 | 是 | 销售属性ID | 
 | | | attribute_value_id | int64 | 否 | 销售属性值ID（平台提供值/通过添加自定义属性接口获取的值） | 
 | | | custom_attribute_value | string | 否 | 商家的自定义销售属性值。
仅在销售属性ID支持自定义属性值时，才可在此字段内入参。
属性值要求：字符数50以内；支持半角符号，不可输入全角符号；不支持unicode，检验表达式可参考：String emojiPattern = "[\\uD83C-\\uDBFF\\uDC00-\\uDFFF\\u2600-\\u27ff]" | 
 | | | language | string | 否 | 自定义属性值的语种。
支持的语种：en、zh-cn、fr、es、it。如果ERP不传多语言内容，平台会做系统翻译。 | 
size_attribute_list | | | | object[] | 否 | 尺码属性列表 | 
 | attribute_id | | | int64 | 是 | 属性ID | 
 | attribute_extra_value | | | string | 否 | 属性值。尺码属性均为手动输入，在此入参。支持正数，最多2位小数 | 
 | relate_sale_attribute_id | | | int64 | 否 | 关联的次销售属性ID（只可入参sku维度销售属性） | 
 | relate_sale_attribute_value | | | string | 否 | 关联的次销售属性属性值。
自定义属性值的场景需要在此入参，入参内容必须和销售属性中填写的属性值一模一样。 | 
 | relate_sale_attribute_value_id | | | int64 | 否 | 关联的次销售属性属性值。非自定义属性值场景在此入参 | 
sale_attribute_sort_list | | | | object[] | 否 | 销售属性自定义排序 | 
 | attribute_id | | | int64 | 是 | 属性名ID | 
 | in_order_attribute_value_id_list | | | int64[] | 否 | 排好序的属性值ID列表。如果属性下无自定义属性值，可用这个字段。 | 
 | in_order_attribute_value_list | | | object[] | 否 | 排好序的属性值ID/自定义属性值备注列表。
如果属性下有自定义属性值，需用这个字段，属性值用哪个形式就入参下面的哪个字段，按排序输入即可。 | 
 | | attribute_value_id | | int64 | 否 | 属性值ID | 
 | | custom_attribute_value | | string | 否 | 自定义属性值的内容。入参内容必须和销售属性中填写的属性值一模一样。 | 
 {
 "category_id": 20039919,
 "product_type_id": 2147503231,
 "multi_language_name_list": [
 {
 "language": "en",
 "name": "name"
 }
 ],
 "supplier_code": "34543345655",
 "site_list": [
 {
 "main_site": "shein",
 "sub_site_list": [
 "shein-us"
 ]
 }
 ],
 "is_spu_pic": "false",
 "suit_flag": "0",
 "size_attribute_list":[
 {
 "attribute_id":" 7",
 "attribute_extra_value":11,
 "relate_sale_attribute_id":"2147484186",
 "relate_sale_attribute_value":"custom attribute value for SKU 0911"
 }
 ],
 "sale_attribute_sort_list":[
 {
 "attribute_id":"2147484187",
 "in_order_attribute_value_list":[
 {
 "custom_attribute_value":"custom attribute value for SKC 0911"
 },
 {
 "attribute_value_id":2147488295
 }
 ]
 },
 {
 "attribute_id":"2147484186",
 "in_order_attribute_value_list":[
 {
 "custom_attribute_value":"custom attribute value for SKU 0911"
 },
 {
 "attribute_value_id":2147488283
 }
 ]
 }
 ],
 "sample_info":{
 "sample_spec":{
 "main_spec":{
 "attribute_id":"2147484187",
 "attribute_value_name":"custom attribute value for SKC 0911"
 },
 "sub_spec_list":[
 {
 "attribute_id": "2147484186",
 "attribute_value_id":"2147488295"
 },
 {
 "attribute_id":"2147484186",
 "attribute_value_name":"custom attribute value for SKU 0911"
 }
 ]
 },
 "sample_judge_type":2,
 "reserve_sample_flag":2,
 "spot_flag":2
 },
 "skc_list": [
 {
 "sale_attribute": {
 "attribute_id": 2147484187,
 "custom_attribute_value":"custom attribute value for SKC 0911",
 "language":"en"
 },
 "image_info": {
 "image_info_list": [
 {
 "image_sort": 1,
 "image_type": 1,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 },
 {
 "image_sort": 2,
 "image_type": 2,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 },
 {
 "image_sort": 3,
 "image_type": 5,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 },
 {
 "image_sort": 4,
 "image_type": 6,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 }
 ]
 },
 "site_detail_image_info_list": [
 {
 "image_info_list": [
 {
 "image_sort": 1,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 }
 ],
 "site_abbr_list": [
 "shein-us"
 ]
 }
 ],
 "proof_of_stock_list": [
 {
 "file_name": "fd",
 "type": "1",
 "url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 }
 ],
 "sku_list": [
 {
 "sale_attribute_list": [
 {
 "attribute_id": 2147484186,
 "custom_attribute_value":"custom attribute value for SKU 0911",
 "language":"en"
 }
 ],
 "price_info_list": [
 {
 "base_price": 334,
 "currency": "USD",
 "special_price": 35,
 "sub_site": "shein-us"
 }
 ],
 "stock_info_list": [
 {
 "inventory_num": 1
 }
 ],
 "supplier_sku": "36636565623",
 "mall_state": 1,
 "height": "1",
 "length": "1",
 "weight": "1",
 "width": "1"
 }
 ],
 "supplier_code": "4564880035",
 "suggested_retail_price": {
 "currency": "USD",
 "price": 34
 }
 },
 {
 "sale_attribute": {
 "attribute_id": 2147484187,
 "attribute_value_id":"2147488295"
 },
 "image_info": {
 "image_info_list": [
 {
 "image_sort": 1,
 "image_type": 1,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 },
 {
 "image_sort": 2,
 "image_type": 2,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 },
 {
 "image_sort": 3,
 "image_type": 5,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 },
 {
 "image_sort": 4,
 "image_type": 6,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 }
 ]
 },
 "site_detail_image_info_list": [
 {
 "image_info_list": [
 {
 "image_sort": 1,
 "image_url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 }
 ],
 "site_abbr_list": [
 "shein-us"
 ]
 }
 ],
 "proof_of_stock_list": [
 {
 "file_name": "fd",
 "type": "1",
 "url": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 }
 ],
 "sku_list": [
 {
 "sale_attribute_list": [
 {
 "attribute_id": 2147484186,
 "attribute_value_id":"2147488283"
 }
 ],
 "price_info_list": [
 {
 "base_price": 334,
 "currency": "USD",
 "special_price": 35,
 "sub_site": "shein-us"
 }
 ],
 "stock_info_list": [
 {
 "inventory_num": 1
 }
 ],
 "supplier_sku": "365650023",
 "mall_state": 1,
 "height": "1",
 "length": "1",
 "weight": "1",
 "width": "1"
 }
 ],
 "supplier_code": "45667800835",
 "suggested_retail_price": {
 "currency": "USD",
 "price": 34
 }
 }
 ]
}
第3步：查询商品详情
查询接口：/open-api/goods/spu-info
商品的自定义销售属性值在此接口中，会给出属性值的内容以及value id。涉及字段包括：skcInfoList - attributeId、attributeMultiList、attributeValueId、attributeValueMultiListskuInfoList - saleAttributeListdimensionAttributeAdditionList -relateSaleAttributeValueId
{
 "code": "0",
 "msg": "OK",
 "info": {
 "spuName": "c250905438333",
 "categoryId": 20039919,
 "productTypeId": 2147503231,
 "brandCode": "",
 "supplierCode": "4545880035",
 "productMultiNameList": [
 {
 "productName": "Bennie For Custom Attribute 0905",
 "language": "en"
 }
 ],
 "productMultiDescList": [
 {
 "productDesc": "",
 "language": "en"
 }
 ],
 "productAttributeInfoList": [
 {
 "attributeId": 2147484186,
 "attributeMultiList": [
 {
 "attributeName": "OPENAPI-Size",
 "language": "en"
 }
 ],
 "attributeValueId": 2147488283,
 "attributeValueMultiList": [
 {
 "attributeValueName": "30*20",
 "language": "en"
 }
 ],
 "attributeValue": null
 },
 {
 "attributeId": 2147484187,
 "attributeMultiList": [
 {
 "attributeName": "OPENAPI-Color",
 "language": "en"
 }
 ],
 "attributeValueId": 2147488294,
 "attributeValueMultiList": [
 {
 "attributeValueName": "Mustard",
 "language": "en"
 }
 ],
 "attributeValue": null
 },
 {
 "attributeId": 2147484186,
 "attributeMultiList": [
 {
 "attributeName": "OPENAPI-Size",
 "language": "en"
 }
 ],
 "attributeValueId": 2147489739,
 "attributeValueMultiList": [
 {
 "attributeValueName": "custom attribute value for SKU",
 "language": "en"
 }
 ],
 "attributeValue": null
 }
 ],
 "dimensionAttributeInfoList": [
 {
 "attributeId": 7,
 "attributeMultiList": [
 {
 "attributeName": "Bag Width66 (1cm)",
 "language": "en"
 }
 ],
 "dimensionAttributeAdditionList": [
 {
 "relateSaleAttributeId": 2147484186,
 "relateSaleAttributeValueId": 2147488283,
 "additionValue": "1"
 },
 {
 "relateSaleAttributeId": 2147484186,
 "relateSaleAttributeValueId": 2147489739,
 "additionValue": "2"
 }
 ]
 },
 {
 "attributeId": 15,
 "attributeMultiList": [
 {
 "attributeName": "Bottoms Length (cm)",
 "language": "en"
 }
 ],
 "dimensionAttributeAdditionList": [
 {
 "relateSaleAttributeId": 2147484186,
 "relateSaleAttributeValueId": 2147488283,
 "additionValue": "1"
 },
 {
 "relateSaleAttributeId": 2147484186,
 "relateSaleAttributeValueId": 2147489739,
 "additionValue": "2"
 }
 ]
 },
 {
 "attributeId": 29,
 "attributeMultiList": [
 {
 "attributeName": "Cuff (cm)",
 "language": "en"
 }
 ],
 "dimensionAttributeAdditionList": [
 {
 "relateSaleAttributeId": 2147484186,
 "relateSaleAttributeValueId": 2147488283,
 "additionValue": "1"
 },
 {
 "relateSaleAttributeId": 2147484186,
 "relateSaleAttributeValueId": 2147489739,
 "additionValue": "2"
 }
 ]
 }
 ],
 "spuImageInfoList": null,
 "skcInfoList": [
 {
 "skcName": "sc25090543833308995",
 "supplierCode": "4545880035",
 "sampleInfo": {
 "sampleCode": "",
 "reserveSampleFlag": 0,
 "spotFlag": 0,
 "sampleJudgeType": 2
 },
 "productMultiNameList": [
 {
 "productName": "Bennie For Custom Attribute 0905",
 "language": "en"
 }
 ],
 "attributeId": 2147484187,
 "attributeMultiList": [
 {
 "attributeName": "OPENAPI-Color",
 "language": "en"
 }
 ],
 "attributeValueId": 2147489740,
 "attributeValueMultiList": [
 {
 "attributeValueName": "custom attribute value for SKC",
 "language": "en"
 }
 ],
 "skuInfoList": [
 {
 "skuCode": "I41m0y0swjql",
 "supplierSku": "366485454623",
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "sellerSkuWeight": {
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "systemSource": 0
 },
 "wmsSkuWeight": {
 "length": null,
 "width": null,
 "height": null,
 "weight": null,
 "packageType": null,
 "systemSource": null
 },
 "skuSupplierInfo": {
 "supplierSku": "366485454623",
 "supplierBarcodeEnabled": false,
 "supplierBarcodeList": []
 },
 "quantity": null,
 "quantityType": null,
 "quantityUnit": null,
 "mallState": 1,
 "stopPurchase": 1,
 "saleAttributeList": [
 {
 "attributeId": 2147484186,
 "attributeValueId": 2147489739,
 "attributeValueMultiList": [
 {
 "attributeValueName": "custom attribute value for SKU",
 "language": "en"
 }
 ]
 }
 ],
 "priceInfoList": [
 {
 "site": "shein-us",
 "basePrice": 334.0,
 "specialPrice": 35.0,
 "currency": "USD"
 }
 ],
 "costInfoList": [],
 "skuImageInfoList": null
 },
 {
 "skuCode": "I41m1jlbevlc",
 "supplierSku": "45345345",
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "sellerSkuWeight": {
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "systemSource": 0
 },
 "wmsSkuWeight": {
 "length": null,
 "width": null,
 "height": null,
 "weight": null,
 "packageType": null,
 "systemSource": null
 },
 "skuSupplierInfo": {
 "supplierSku": "45345345",
 "supplierBarcodeEnabled": false,
 "supplierBarcodeList": []
 },
 "quantity": null,
 "quantityType": null,
 "quantityUnit": null,
 "mallState": 1,
 "stopPurchase": 1,
 "saleAttributeList": [
 {
 "attributeId": 2147484186,
 "attributeValueId": 2147488283,
 "attributeValueMultiList": [
 {
 "attributeValueName": "30*20",
 "language": "en"
 }
 ]
 }
 ],
 "priceInfoList": [
 {
 "site": "shein-us",
 "basePrice": 33.0,
 "specialPrice": 23.0,
 "currency": "USD"
 }
 ],
 "costInfoList": [],
 "skuImageInfoList": null
 }
 ],
 "shelfStatusInfoList": [
 {
 "siteAbbr": "shein-us",
 "shelfStatus": 1,
 "lastShelfTime": "2025-09-05 14:00:06",
 "firstShelfTime": "2025-09-05 14:00:06",
 "lastUpdateTime": "2025-09-05 14:00:06",
 "link": "https://us.shein.com/Bennie-For-Custom-Attribute-0905-p-54645646522692-cat-4913127337.html"
 }
 ],
 "recycleInfoList": null,
 "skcImageInfoList": [
 {
 "groupCode": "G21ja2yef1mm",
 "imageItemId": 2148036234,
 "imageType": "MAIN",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_405x552.jpeg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_220x293.jpeg",
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg",
 "sort": 1
 },
 {
 "groupCode": "G21ja2yef1mm",
 "imageItemId": 2148036235,
 "imageType": "DETAIL",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_405x552.jpeg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_220x293.jpeg",
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg",
 "sort": 2
 },
 {
 "groupCode": "G21ja2yef1mm",
 "imageItemId": 2148036236,
 "imageType": "SQUARE",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_405x552.jpeg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_220x293.jpeg",
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg",
 "sort": 3
 },
 {
 "groupCode": "G21ja2yef1mm",
 "imageItemId": 2148036237,
 "imageType": "PIECE",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_405x552.jpeg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_220x293.jpeg",
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg",
 "sort": 4
 }
 ],
 "siteDetailImageInfoList": null,
 "proofOfStockInfoList": [],
 "srpPriceInfo": {
 "currency": "USD",
 "srpPrice": 34.0
 }
 },
 {
 "skcName": "sc25090543833396934",
 "supplierCode": "4545880035",
 "sampleInfo": {
 "sampleCode": "",
 "reserveSampleFlag": 0,
 "spotFlag": 0,
 "sampleJudgeType": 2
 },
 "productMultiNameList": [
 {
 "productName": "Bennie For Custom Attribute 0905",
 "language": "en"
 }
 ],
 "attributeId": 2147484187,
 "attributeMultiList": [
 {
 "attributeName": "OPENAPI-Color",
 "language": "en"
 }
 ],
 "attributeValueId": 2147488295,
 "attributeValueMultiList": [
 {
 "attributeValueName": "Navy",
 "language": "en"
 }
 ],
 "skuInfoList": [
 {
 "skuCode": "I41m0y0syo5g",
 "supplierSku": "3655435436523",
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "sellerSkuWeight": {
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "systemSource": 0
 },
 "wmsSkuWeight": {
 "length": null,
 "width": null,
 "height": null,
 "weight": null,
 "packageType": null,
 "systemSource": null
 },
 "skuSupplierInfo": {
 "supplierSku": "3655435436523",
 "supplierBarcodeEnabled": false,
 "supplierBarcodeList": []
 },
 "quantity": null,
 "quantityType": null,
 "quantityUnit": null,
 "mallState": 1,
 "stopPurchase": 1,
 "saleAttributeList": [
 {
 "attributeId": 2147484186,
 "attributeValueId": 2147488283,
 "attributeValueMultiList": [
 {
 "attributeValueName": "30*20",
 "language": "en"
 }
 ]
 }
 ],
 "priceInfoList": [
 {
 "site": "shein-us",
 "basePrice": 334.0,
 "specialPrice": 35.0,
 "currency": "USD"
 }
 ],
 "costInfoList": [],
 "skuImageInfoList": null
 },
 {
 "skuCode": "I41m1jlbh70p",
 "supplierSku": "45345",
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "sellerSkuWeight": {
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "systemSource": 0
 },
 "wmsSkuWeight": {
 "length": null,
 "width": null,
 "height": null,
 "weight": null,
 "packageType": null,
 "systemSource": null
 },
 "skuSupplierInfo": {
 "supplierSku": "45345",
 "supplierBarcodeEnabled": false,
 "supplierBarcodeList": []
 },
 "quantity": null,
 "quantityType": null,
 "quantityUnit": null,
 "mallState": 1,
 "stopPurchase": 1,
 "saleAttributeList": [
 {
 "attributeId": 2147484186,
 "attributeValueId": 2147489739,
 "attributeValueMultiList": [
 {
 "attributeValueName": "custom attribute value for SKU",
 "language": "en"
 }
 ]
 }
 ],
 "priceInfoList": [
 {
 "site": "shein-us",
 "basePrice": 33.0,
 "specialPrice": 23.0,
 "currency": "USD"
 }
 ],
 "costInfoList": [],
 "skuImageInfoList": null
 }
 ],
 "shelfStatusInfoList": [
 {
 "siteAbbr": "shein-us",
 "shelfStatus": 1,
 "lastShelfTime": "2025-09-05 14:00:06",
 "firstShelfTime": "2025-09-05 14:00:06",
 "lastUpdateTime": "2025-09-05 14:00:06",
 "link": "https://us.shein.com/Bennie-For-Custom-Attribute-0905-p-54645646522693-cat-4913127337.html"
 }
 ],
 "recycleInfoList": null,
 "skcImageInfoList": [
 {
 "groupCode": "G21m0y2n7hfw",
 "imageItemId": 2148036238,
 "imageType": "MAIN",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_405x552.jpeg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_220x293.jpeg",
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg",
 "sort": 1
 },
 {
 "groupCode": "G21m0y2n7hfw",
 "imageItemId": 2148036239,
 "imageType": "DETAIL",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_405x552.jpeg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_220x293.jpeg",
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg",
 "sort": 2
 },
 {
 "groupCode": "G21m0y2n7hfw",
 "imageItemId": 2148036240,
 "imageType": "SQUARE",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_405x552.jpeg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_220x293.jpeg",
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg",
 "sort": 3
 },
 {
 "groupCode": "G21m0y2n7hfw",
 "imageItemId": 2148036241,
 "imageType": "PIECE",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_405x552.jpeg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226_thumbnail_220x293.jpeg",
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg",
 "sort": 4
 }
 ],
 "siteDetailImageInfoList": [
 {
 "imageGroupCode": "G41j8kjqvt7w",
 "imageInfoList": [
 {
 "imageItemId": 1147541301,
 "imageSort": 1,
 "imageUrl": "https://imgdeal-test01.shein.com/images3_pi/2024/12/10/27/17338148602250996226.jpeg"
 }
 ],
 "siteInfoList": [
 {
 "channel": "",
 "mainSite": "shein",
 "site": "shein-us"
 }
 ]
 }
 ],
 "proofOfStockInfoList": [],
 "srpPriceInfo": {
 "currency": "USD",
 "srpPrice": 34.0
 }
 },
 {
 "skcName": "sc25090543833306711",
 "supplierCode": "4545880035",
 "sampleInfo": {
 "sampleCode": "",
 "reserveSampleFlag": 0,
 "spotFlag": 0,
 "sampleJudgeType": 2
 },
 "productMultiNameList": [
 {
 "productName": "Bennie For Custom Attribute 0905",
 "language": "en"
 }
 ],
 "attributeId": 2147484187,
 "attributeMultiList": [
 {
 "attributeName": "OPENAPI-Color",
 "language": "en"
 }
 ],
 "attributeValueId": 2147488294,
 "attributeValueMultiList": [
 {
 "attributeValueName": "Mustard",
 "language": "en"
 }
 ],
 "skuInfoList": [
 {
 "skuCode": "I41m1jlbjmfa",
 "supplierSku": "5345354354",
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "sellerSkuWeight": {
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "systemSource": 0
 },
 "wmsSkuWeight": {
 "length": null,
 "width": null,
 "height": null,
 "weight": null,
 "packageType": null,
 "systemSource": null
 },
 "skuSupplierInfo": {
 "supplierSku": "5345354354",
 "supplierBarcodeEnabled": false,
 "supplierBarcodeList": []
 },
 "quantity": null,
 "quantityType": null,
 "quantityUnit": null,
 "mallState": 1,
 "stopPurchase": 1,
 "saleAttributeList": [
 {
 "attributeId": 2147484186,
 "attributeValueId": 2147489739,
 "attributeValueMultiList": [
 {
 "attributeValueName": "custom attribute value for SKU",
 "language": "en"
 }
 ]
 }
 ],
 "priceInfoList": [
 {
 "site": "shein-us",
 "basePrice": 33.0,
 "specialPrice": 23.0,
 "currency": "USD"
 }
 ],
 "costInfoList": [],
 "skuImageInfoList": null
 },
 {
 "skuCode": "I41m1jlbirjp",
 "supplierSku": "435344545",
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "sellerSkuWeight": {
 "length": "1.00",
 "width": "1.00",
 "height": "1.00",
 "weight": 1,
 "packageType": 0,
 "systemSource": 0
 },
 "wmsSkuWeight": {
 "length": null,
 "width": null,
 "height": null,
 "weight": null,
 "packageType": null,
 "systemSource": null
 },
 "skuSupplierInfo": {
 "supplierSku": "435344545",
 "supplierBarcodeEnabled": false,
 "supplierBarcodeList": []
 },
 "quantity": null,
 "quantityType": null,
 "quantityUnit": null,
 "mallState": 1,
 "stopPurchase": 1,
 "saleAttributeList": [
 {
 "attributeId": 2147484186,
 "attributeValueId": 2147488283,
 "attributeValueMultiList": [
 {
 "attributeValueName": "30*20",
 "language": "en"
 }
 ]
 }
 ],
 "priceInfoList": [
 {
 "site": "shein-us",
 "basePrice": 33.0,
 "specialPrice": 23.0,
 "currency": "USD"
 }
 ],
 "costInfoList": [],
 "skuImageInfoList": null
 }
 ],
 "shelfStatusInfoList": [
 {
 "siteAbbr": "shein-us",
 "shelfStatus": 0,
 "lastShelfTime": "2018-08-28 00:00:00",
 "firstShelfTime": "1970-01-01 08:00:01",
 "lastUpdateTime": "2025-09-05 14:16:27",
 "link": "https://us.shein.com/Bennie-For-Custom-Attribute-0905-p-54645646522710-cat-4913127337.html"
 }
 ],
 "recycleInfoList": null,
 "skcImageInfoList": [
 {
 "groupCode": "G01vcmbtfn5k",
 "imageItemId": 2148036302,
 "imageType": "MAIN",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/a7/1757052939fe552dac89a2f5d12503e7afff826dbe_thumbnail_405x552.jpg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/a7/1757052939fe552dac89a2f5d12503e7afff826dbe_thumbnail_220x293.jpg",
 "imageUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/a7/1757052939fe552dac89a2f5d12503e7afff826dbe.jpg",
 "sort": 1
 },
 {
 "groupCode": "G01vcmbtfn5k",
 "imageItemId": 2148036303,
 "imageType": "DETAIL",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/62/1757052939de92a781e416b49f1d299c1489a94d71_thumbnail_405x552.jpg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/62/1757052939de92a781e416b49f1d299c1489a94d71_thumbnail_220x293.jpg",
 "imageUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/62/1757052939de92a781e416b49f1d299c1489a94d71.jpg",
 "sort": 2
 },
 {
 "groupCode": "G01vcmbtfn5k",
 "imageItemId": 2148036304,
 "imageType": "DETAIL",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/53/1757052939be6a4855caf38d4045211ca2fd081d59_thumbnail_405x552.jpg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/53/1757052939be6a4855caf38d4045211ca2fd081d59_thumbnail_220x293.jpg",
 "imageUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/53/1757052939be6a4855caf38d4045211ca2fd081d59.jpg",
 "sort": 3
 },
 {
 "groupCode": "G01vcmbtfn5k",
 "imageItemId": 2148036305,
 "imageType": "DETAIL",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/df/1757052939abdf9d03aaeae017c715bbf69efef417_thumbnail_405x552.jpg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/df/1757052939abdf9d03aaeae017c715bbf69efef417_thumbnail_220x293.jpg",
 "imageUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/df/1757052939abdf9d03aaeae017c715bbf69efef417.jpg",
 "sort": 4
 },
 {
 "groupCode": "G01vcmbtfn5k",
 "imageItemId": 2148036306,
 "imageType": "SQUARE",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/1e/175705293940f3cb182c3d04df3a2d17ca84c0b4d2_thumbnail_405x552.jpg",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/1e/175705293940f3cb182c3d04df3a2d17ca84c0b4d2_thumbnail_220x293.jpg",
 "imageUrl": "https://imgdeal-test01.shein.com/v4/j/pi/2025/09/05/1e/175705293940f3cb182c3d04df3a2d17ca84c0b4d2.jpg",
 "sort": 5
 },
 {
 "groupCode": "G01vcmbtfn5k",
 "imageItemId": 2148036307,
 "imageType": "PIECE",
 "imageMediumUrl": "https://imgdeal-test01.shein.com/v4/p/pi/2025/09/05/65/175705293910d4d904ed8af6396c39f713758a10ef_thumbnail_405x552.png",
 "imageSmallUrl": "https://imgdeal-test01.shein.com/v4/p/pi/2025/09/05/65/175705293910d4d904ed8af6396c39f713758a10ef_thumbnail_220x293.png",
 "imageUrl": "https://imgdeal-test01.shein.com/v4/p/pi/2025/09/05/65/175705293910d4d904ed8af6396c39f713758a10ef.png",
 "sort": 6
 }
 ],
 "siteDetailImageInfoList": null,
 "proofOfStockInfoList": [],
 "srpPriceInfo": {
 "currency": "USD",
 "srpPrice": 33.0
 }
 }
 ]
 },
 "bbl": null,
 "traceId": "d8d37306e13e15f6"
}
3 测试店铺
测试调用域名：https://openapi-test01.sheincorp.cn
openKey：(SHEIN public test key — see the guide page)
secretKey：(see the guide page)
4 常见FAQ
Q:：商家切换为新的属性方案后，无法从查询属性接口中获得自定义属性值的attribute value id，如需使用可以从哪里获取？
A：可以通过查询SPU详情接口/open-api/goods/spu-info获取，此接口中会返回自定义属性值的value id
```


## POST `/open-api/goods/transform-pic` — 图片链接转换
Doc id 3001360 · updated 2025-08-12 11:32:52 · QPS 60

支持将外部的图片地址转换成SHEIN可用的图片地址，各类型图片需满足下方要求，否则无法转换，建议开发者将图片在本地处理完成后再调用接口。 - 主图（type=1)、细节图（type=2)：像素满足1340px*1785px，或宽高比例1:1，像素范围900px-2200px；格式JPG/JPEG/PNG；大小≤3MB - 方形图（type=5）：宽高比例1:1；像素范围900*900~2200*2200 px；格式JPG/JPEG/PNG；大小≤3MB - 色块图（type=6）：宽高比例1:1；像素80×80 px；格式JPG/JPEG/PNG；大小≤3MB - 详情图（type=7）：宽高比例3:4，像素大于900px； 格式JPG/JPEG/PNG；大小≤3MB 每个店铺的各个分类下，需要传什么类型的图、可以传几张图，可通过文档确认：商品图片。

**Request body**
- `image_type` integer **required** — 图片类型(1:主图; 2:细节图; 5:方块图; 6:色块图; 7:详情图) 。 各个类型的图片要求参考文档顶部的描述。
- `original_url` string **required** — 图片地址。

**Response body**
- `bbl` object — bbl
  - `info` object — 
    - `*` object[] — 
  - `npid` string — 
- `code` string **required** — 成功: 0
- `info` object — 
  - `failure_reason` string — 失败原因
  - `original` string **required** — 图片链接
  - `transformed` string — 转换后的图片链接
- `msg` string — 错误描述, 成功: OK
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "original": "http://imgdeal-test01.shein.com/images3_pi/2023/11/15/fe/17000325694031071724_square.jpg", "transformed": "", "failure_reason": "图片下载异常" }, "bbl": null }


## POST `/open-api/goods/query-document-state` — 查询商品审核状态
Doc id 3001368 · updated 2025-08-15 14:49:04 · QPS 70

支持通过spu查询skc的审核状态，支持查询spu指定版本的审核状态；同时，平台也支持webhook消息通知的方式推送商品审核结果，具体可查看商品公文审核通知

**Request body**
- `spuList` object[] **required** — spu列表，1次最多传10个spu
  - `spuName` string **required** — spuName，spuName是SHEIN生成的系统编码
  - `version` string — 审核版本号。当商品发布或编辑提交后，响应中会包含version。

**Response body**
- `code` string **required** — 响应编码 成功：0
- `info` object — 
  - `data` object[] — 结果
    - `skcList` object[] — skc集合
      - `documentSn` string — 公文号
      - `documentState` integer — 公文状态。-1：接受失败 1：待审核 2：审批成功 3：审批失败 4：已撤回 5：申诉中
      - `failedReason` object[] — 审批失败的原因
        - `content` string — 内容
        - `language` string — 语种
      - `skcName` string — skcName，skcNname是SHEIN生成的系统编码
    - `spuName` string — spuName，spuName是SHEIN生成的系统编码
    - `version` string — 审核版本号
  - `meta` object — 元数据
    - `count` integer — 数据记录数
    - `customObj` object — 用户自定义扩展
- `msg` string — 错误描述,成功：OK
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "data": [ { "spuName": "MM2404076986", "version": "SPMP240407262081729", "skcList": [ { "skcName": "sMM24040769866671", "documentSn": "SPMPA320240407000135", "documentState": 3, "failedReason": [ { "language": "zh-cn", "content": "禁忌:frankie test12;1111111" }, { "language": "zh-cn", "content": "上新管控:测试上新管控驳回·1;1111111" } ] } ] } ], "meta": { "count": 1, "customObj": null } }, "bbl": null }


## POST `/open-api/goods/get-custom-attribute-permission-config` — 查询是否支持自定义属性值
Doc id 3001369 · updated 2025-08-15 14:57:20 · QPS 40

查询某个分类是否可以自定义销售属性的属性值。 注意：并非所有商家、所有分类都可以自定义属性值。创建自定义属性值之前一定要先查询此接口确定X商家的Y分类可自定义属性值。

**Request body**
- `category_id_list` int64[] **required** — 末级分类ID，最多支持200个

**Response body**
- `bbl` object — bbl
  - `info` object — 
    - `*` object[] — 
- `code` string **required** — Result(success: 0)
- `info` object — 
  - `data` object[] — 分类下销售属性信息
    - `attribute_id` int64 — 属性id
    - `last_category_id` int64 — 末级分类id
    - `has_permission` integer — 属性是否支持自定义属性值。1-支持；0-不支持
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "data": [ { "has_permission": 1, "last_category_id": 2103, "attribute_id": 27 }, { "has_permission": 1, "last_category_id": 2103, "attribute_id": 87 } ], "meta": { "count": 2, "customObj": null } }, "bbl": null }


## POST `/open-api/goods/product/check-supplierSku-repeated` — 查询商家sku是否已存在
Doc id 3001437 · updated 2025-10-22 20:45:14 · QPS 60

平台要求商品的商家sku（即发布接口中的supplier_sku）在店铺内全局唯一。 建议在发布商品前调用，查询本次输入的商家sku是否在店内已存在（包括已发布商品以及审核中商品），如果已存在引导商家更换信息。

**Request body**
- `supplierSkuList` string[] **required** — 商家sku。单次最多可查询200个。

**Response body**
- `code` string — 响应编码 成功：0
- `msg` string — 响应信息。成功：OK
- `info` object[] **required** — 详细信息
  - `supplierSku` string — 查询时入参的商家sku
  - `repeated` boolean — 是否已存在。 true=已存在；false=不存在
- `traceId` string — 追踪码

**Response example (trimmed)**



## POST `/open-api/goods/add-custom-attribute-value` — 添加自定义属性值
Doc id 3001483 · updated 2025-12-18 10:31:29 · QPS 40

2025年12月1日前创建的应用可使用此接口，先确认属性是否支持添加自定义属性值（通过接口确认），则可通过此接口添加自定义属性值。同时也可迁移使用新方案：点击查看 2025年12月1日后创建的应用请使用商品发布编辑接口创建自定义属性，详细使用方式查看文档：点击查看

**Request body**
- `attribute_id` int64 **required** — 属性ID。 要在哪个属性下添加自定义属性值。
- `attribute_value` string **required** — 自定义属性值。最多100个字符，特殊符号需使用半角，不支持全角符号。
- `category_id` int64 **required** — 末级分类id
- `attribute_value_name_multis` object[] — 自定义属性值的多语言
  - `language` string — 语种
  - `attribute_value_name_multi` string — 自定义属性值（多语言）。最多100个字符，特殊符号需使用半角，不支持全角符号。

**Response body**
- `bbl` object — bbl
  - `info` object — 
    - `*` object[] — 
- `code` string **required** — Result(success: 0)
- `info` object — 
  - `attribute_id` int64 — 属性名ID
  - `attribute_value_id` int64 — 属性值ID
  - `attribute_value_name` string — 属性值名称
  - `category_id` int64 — 末级分类ID
  - `supplier_id` int64 — 商家ID
  - `supplier_source` integer — 商家来源
  - `attribute_value_multi_arr` object[] — 属性值多语种信息
    - `attribute_value_name_multi` string — 属性值多语种名称
    - `language` string — 语种
- `msg` string — 错误描述,成功：OK
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "supplier_id": ******, "supplier_source": 10, "category_id": 4455, "attribute_id": 27, "attribute_value_id": 5242406, "attribute_value_name": "Navy/Bittersweet/Peacoat", "attribute_value_multi_arr": [ { "attribute_value_name_multi": "البحرية / حلو ومر / Peacoat", "language": "ar" }, { "attribute_value_name_multi": "Navy/Bittersweet/Peacoat", "language": "cs-cz" }, { "attribute_value_name_multi": "Marineblau/Bittersüß/Peacoat", "language": "de" }, { "attribute_value_name_multi": "Ναυτικό/Γλυκόπικρο/Παγώνι", "language": "el-gr" }, { "attribute_value_name_multi": "Navy/Bittersweet/Peacoat", "language": "en" }, { "attribute_value_name_multi": "Azul marino/Agridulce/Chaquetón", "language": "es" }, { "attribute_value_name_multi": "Bleu marine/doux-amer/caban", "language": "fr" }, { "attribute_value_name_multi": "חיל הים/מריר/טווס", "language": "he" }, { "attribute_value_name_multi": "Angkatan Laut/Pahit Manis/Peacoat", "language": "id" }, { "attribute_value_name_multi": "Blu marino/Agrodolce/Peacoat", "language": "it" }, { "attribute_value_name_multi": "ネイビー/ビタースイート/ピーコート", "language": "ja" }, { "attribute_value_name_multi": "네이비/비터스위트/피코트", "language": "ko" }, { "attribute_value_name_multi": "Marineblauw/bitterzoet/peacoat", "language": "nl" }, { "attribute_value_name_multi": "Granatowy / Słodko-gorzki / Peacoat", "language": "pl" }, { "attribute_value_name_multi": "Marinha/Agridoce/Peacoat", "language": "pt-br" }, { "attribute_value_name_mult


## GET `/open-api/goods/product/check-publish-permission` — 确认店铺是否可发品
Doc id 3001589 · updated 2026-02-06 18:06:06 · QPS 40

发布商品前调用接口，确认商家店铺是否有发布商品资格。店铺会因为多种原因导致无法发品，大多需要商家前往商家后台处理，此接口覆盖以下原因： 1、店铺已关闭。即无法运营。 2、店铺当前有禁止发品的违规单，需按平台建议处理。 3、店铺的部分站点KYC未完成，KYC认证后可发品。 4、自运营类型店铺的所有站点发货&退货地址未维护，维护后可发品。 5、自运营/半托管店铺的在架额度为0，全托管店铺的可发品额度为0。 6、店铺无可用的上架站点。

**Request body**

**Response body**
- `code` string **required** — 响应编码。响应成功：0
- `info` object — 店铺发品资格信息
  - `canPublishProduct` boolean — 店铺是否可发品。 true-可发品；false-不可发品。
  - `reason` string — 不可发品的原因。只有当canPublishProduct=false时才有值。
- `msg` string — 响应信息,成功：OK

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "canPublishProduct": false, "reason": "商家维护好站点的发货、退货地址后，才可发布商品。站点包括：shein-fr,shein-es,shein-de,shein-it,shein-nl,shein-se,shein-pl,shein-pt。请商家前往SHEIN后台维护地址。" }, "traceId": "8f159ea3e8e0413c" }


## POST `/open-api/goods/query-category-tree` — 店铺查商品末级分类
Doc id 3001594 · updated 2026-02-20 11:00:30 · QPS 40

该API支持查询店铺的商品末级分类信息，不同店铺，分类会有差异。

**Request body**

**Response body**
- `bbl` object — bbl
  - `info` object — 
    - `*` object[] — 
- `code` string **required** — Result(success: 0)
- `info` object — 
  - `data` object[] — 
    - `category_id` int64 — 分类id
    - `category_name` string — 分类名称，建议开发者在系统界面显示该名称，便于运营选择类目
    - `children` object[] — 子分类列表
    - `last_category` boolean — 是否末级分类（true：末级分类，false：非末级分类）
    - `parent_category_id` int64 — 上级分类id
    - `product_type_id` int64 — 商品类型ID仅存在于末级分类中，用作商品发布接口的入参；通常一个分类ID对应一个商品类型ID
  - `meta` object — 
    - `count` integer — 
    - `customObj` object — 
- `msg` string — message
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "data": [ { "category_id": 2028, "product_type_id": 0, "parent_category_id": 0, "category_name": "女士", "last_category": false, "children": [ { "category_id": 2033, "product_type_id": 0, "parent_category_id": 2028, "category_name": "Clothing", "last_category": false, "children": [ { "category_id": 1767, "product_type_id": 0, "parent_category_id": 2033, "category_name": "Dresses中文", "last_category": false, "children": [ { "category_id": 1727, "product_type_id": 1080, "parent_category_id": 1767, "category_name": "Dresses/中文-四级", "last_category": true, "children": [] }, { "category_id": 1740, "product_type_id": 1080, "parent_category_id": 1767, "category_name": "长裤", "last_category": true, "children": [] }, { "category_id": 1756, "product_type_id": 165, "parent_category_id": 1767, "category_name": "女士首饰套装", "last_category": true, "children": [] }, { "category_id": 1757, "product_type_id": 80, "parent_category_id": 1767, "category_name": "耳环", "last_category": true, "children": [] }, { "category_id": 1759, "product_type_id": 79, "parent_category_id": 1767, "category_name": "戒指", "last_category": true, "children": [] }, { "category_id": 1777, "product_type_id": 91, "parent_category_id": 1767, "category_name": "女士胸针", "last_category": true, "children": [] }, { "category_id": 1871, "product_type_id": 164, "parent_category_id": 1767, "category_name": "打底裤", "last_category": true, "children": [] }, { "category_id": 1912, "product_type_id": 75, "par


## POST `/open-api/goods/get-associated-attribute-rules` — 查询关联属性填写规则
Doc id 3001680 · updated 2026-04-21 17:39:13 · QPS 60

发布或编辑商品时，某个商品属性（attribute_type=3/4）或尺码属性（attribute_type=2）是否必填有两层规则：基础规则、关联规则。 基础规则：通过/open-api/goods/query-attribute-template获取，attribute_status=3代表属性必填。 关联规则：在基础规则上，部分非必填属性因业务要求也会变成必填。 规则1：选择A属性的A1属性值，导致B属性必填（B属性原本可能是非必填） 规则2：选择A属性的A1属性值、B属性的B1属性值，导致C属性必填，且可能存在必填属性值C1、C2、C3范围（C属性原本可能是非必填） 此接口可查询关联规则，建议在商品发布之前调用，将填写的所有商品属性&属性值作为入参，查看是否存在需要填写的关联属性。（不要输入销售、尺码属性）

**Request body**
- `get_linked_rule_req_list` object[] **required** — 输入所有已填写的商品属性（不要给销售、尺码属性），接口会返回这些属性组合情况下，会有哪些关联属性必填。 支持同时查询多个商品的关联属性规则，每个商品信息记为一组，例如同时查询商品A、商品B的关联规则，则A的信息作为group1，B的信息作为group2查询。
  - `group_id` string — 组别id，开发者自定义值即可，批量查询商品时用于定位，单次请求最多支持10个group。
  - `category_id` int64 **required** — 商品末级分类id
  - `product_type_id` int64 **required** — 商品末级分类对应的类型id
  - `attribute_list` object[] **required** — 已填写的商品属性列表。列表内可填写的attribute_id数量没有限制。
    - `attribute_id` int64 **required** — 属性名id
    - `attribute_value_id` int64 — 属性值id；如果属性名下都多个属性值，需提供多组信息。 当属性值的输入方式attribute_mode=4（下拉选择+手动输入）时，将下拉选择的value id入参至此处，手动输入的attribute_extra_value不用录入

**Response body**
- `code` string **required** — 响应码。响应正常为0。
- `msg` string **required** — 响应信息。响应正常为OK。
- `info` object **required** — 响应详情
  - `data` object[] **required** — 规则信息
    - `group_id` string — 组别id。内容和入参时保持一致。
    - `link_rule_attribute_list` object[] — 关联属性必填规则。 此对象下若无值，则代表没有必填的关联属性。若有值，则所有的attribute_id都是必填。若attribute_value_list或attribute_value_pre_fill_list有值，则代表必须在2个list的合集范围内选择属性值。 结果中出现入参中填入的attribute_id是正常现象。
      - `attribute_id` int64 — 属性名id。 可能会出现商品属性或尺码属性。
      - `attribute_value_list` int64[] — 属性值id；若此字段有值（可能1个或多个），代表必须在list范围内选择属性值。若无值，代表属性值没有范围要求。 此列表和attribute_value_pre_fill_list里都可能会有值，需要取两者的合集。
      - `attribute_value_pre_fill_list` int64[] — 属性值id；若此字段有值（可能1个或多个），代表必须在list范围内选择属性值。若无值，代表属性值没有范围要求。 此列表和attribute_value_list里都可能会有值，需要取两者的合集。
  - `meta` object **required** — 数据统计
    - `count` integer — count对象为group_id
- `traceId` string **required** — 请求追踪码

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "data": [ { "group_id": "1", "link_rule_attribute_list": [ { "attribute_id": 2147484196, "attribute_value_list": [ 440, 442 ], "attribute_value_pre_fill_list": [] }, { "attribute_id": 2147484188, "attribute_value_list": [ 290, 372, 325, 327, 62, 154, 91 ], "attribute_value_pre_fill_list": [ 154, 91 ] } ] }, { "group_id": "2", "link_rule_attribute_list": [ { "attribute_id": 2147484196, "attribute_value_list": [ 440, 442 ], "attribute_value_pre_fill_list": [] }, { "attribute_id": 2147484188, "attribute_value_list": [ 290, 372, 325, 327, 62, 154, 91 ], "attribute_value_pre_fill_list": [ 154, 91 ] } ] } ], "meta": { "count": 2, "customObj": null } }, "bbl": null, "traceId": "55d05009ca82c48f" }


## POST `/open-api/goods/query-brand-list` — 店铺查品牌列表
Doc id 3001900 · updated 2026-07-02 21:01:07 · QPS 40

该API支持查询店铺可用的品牌信息，店铺品牌会变动，请定期更新。

**Request body**

**Response body**
- `bbl` object — bbl
  - `info` object — 
    - `*` object[] — 
- `code` string **required** — Result(success: 0)
- `info` object — 
  - `data` object[] — 
    - `brand_code` string — 品牌编码
    - `brand_name` string — 品牌名称
  - `meta` object — 
    - `count` integer — 
    - `customObj` object — 
- `msg` string — 
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "data": [ { "brand_code": "2u1ys", "brand_name": "shein品牌" }, { "brand_code": "2pg9i", "brand_name": "这是品牌" }, { "brand_code": "24rjv", "brand_name": "品牌数据" }, { "brand_code": "2nz97", "brand_name": "品牌111" } ], "meta": { "count": 4, "customObj": null } }, "bbl": null }


## POST `/open-api/goods/query-shelf-quota` — 获取店铺上架额度
Doc id 3001931 · updated 2026-07-23 11:04:59 · QPS 40

平台对店铺可上架的商品SKC数量有管控，请在调用商品上架接口之前先查询店铺可上架额度，有额度时再操作上架。 仅自运营、半托管模式的商家会被管控上架额度。

**Request body**
- `brand_code` string — 店铺的可用品牌code，可通过接口/open-api/goods/query-brand-list获取。 部分商家的部分品牌，可能会开启额度豁免，即此品牌下的商品不管控数量，因此如果商家发布品牌商品，可入参code后查询。

**Response body**
- `code` string — 响应编码 成功：0
- `msg` string — 响应信息。成功：OK
- `info` object **required** — 详细信息
  - `need` boolean — 店铺是否被管控上架额度。 true=被管控，剩余可用额度（remain_count）大于0时，代表还能上架SKC； false=不被管控，即店铺可上架SKC数没有限制；
  - `total_quota_count` integer — 总的可上架SKC数量。
  - `on_shelf_count` integer — 已上架的SKC数量
  - `remain_count` integer — 剩余可上架SKC数量
- `traceId` string — 追踪码

**Response example (trimmed)**



## POST `/open-api/goods/product/publishOrEdit` — 商品发布/编辑
Doc id 3002018 · updated 2026-09-02 10:14:04 · QPS 40

接口支持场景：新发布商品（SPU）、更新已发布的商品信息、在已发布商品下新增SKC/SKU 各场景的对接指南：不同应用模式、不同场景中此接口的使用方式有较大差异，建议浏览API文档时结合场景的对接方案，了解详细的对接。 - 新发布商品场景：商品发布-自运营、商品发布-半托管、商品发布-全托管 - 更新已发布商品 & 在已发布商品下新增SKC/SKU场景：商品编辑-自运营、商品编辑-半托管、商品编辑-全托管

**Request body**
- `brand_code` string — 店铺可用的品牌code。 部分商家必填，通过【商品发布规范】API确认，当field_key=brand_code & required=true则必填。code必须从通过【店铺查品牌列表】API获取。 编辑商品信息时，传""代表清空。
- `category_id` int64 **required** — 末级分类id。 通过【店铺查商品末级分类】API获取，last_category=true代表末级分类。注意：编辑已审核通过的SPU时，不允许修改category_id。
- `product_type_id` int64 — 商品类型id。 发布新品时需通过【店铺查商品末级分类】API获取。编辑商品时建议通过/open-api/goods/spu-info来获取，平台会有修改商品category_id但不改product_type_id的情况。
- `source_system` string — 固定OpenAPI
- `spu_name` string — 平台生成的SPU唯一编码。 新发布商品/在已发布下新增SKC时不可传，编辑必传。
- `supplier_code` string — 商家货号，到主规格粒度，最多200个字符，具体可查看supplier_code FAQ
- `suit_flag` string — 是否套装。1-是，0-否。 API暂不支持套装，所以必须传0。不入参时系统默认赋值0。
- `is_spu_pic` boolean — 是否使用新版图片方案。true-用新方案，false-用旧方案 不传字段默认给false。新旧方案的传图差异大，请参考商品图片方案了解详细信息。
- `ip_character_list` object[] — 商品IP。目前每个商品仅支持绑定1个IP。 店铺可用的IP可通过接口获取：/open-api/goods/query-ip-list。店铺能否传IP，需通过规范接口确认，"ip_character"的"show": true代表可传。
  - `ip_id` int64 **required** — IP的ID。若传ip_character_list，则ip_id必传。
  - `ip_name` string — IP的英语名称
  - `ip_name_cn` string — IP的中文名称
- `fill_configuration_info` object — 商品信息填写规则。 商品发布有较多新的填写规则，接口层兼容新老方案，但需开发者通过此字段告知平台当前使用了新方案还是老方案，从而决策如何进行发布校验。
  - `filled_quantity_to_sku` boolean — 是否在sku维度填写件数。 此字段用于告诉系统， 不是所有商家所有类目都支持在sku维度传件数，请先查询商品发布规范，若"field_key": "quantity_info"，且"show"="true"，则代表此分类支持SKU填写件数。 不传值默认按false处理，若传true，则必须在sku_list -> quantity_info中传值。更多件数入参示例参考FAQ
  - `fill_configuration_tags` string[] — 是否在本次入参中填写某些信息。若填写了A信息则在此处填写上A。 目前可输入的枚举值：PACKAGE_TYPE_TO_SKU - 对应SKU维度的包装类型（package_type）
- `image_info` object — SPU图片列表。 仅is_spu_pic=true时可传，请参考商品图片方案了解详细信息。 编辑商品信息时，如果不传字段代表清空数据。
  - `image_group_code` string — 图片组编码。 新发布商品/在已发布下新增SKC时不可传，编辑必传。通过查询SPU详情获取。
  - `image_info_list` object[] — 图片列表。 需要提供哪些类型的图片、数量限制、各类型图片的尺寸要求，请参考商品图片方案了解详细信息。
    - `image_item_id` int64 — 由平台生成的图片唯一编码。 新发布商品/在已发布下新增SKC时不可传，编辑时部分情况必传，请参考入参示例
    - `image_sort` integer — 图片序号。 同个图片组内序号值不可重复。若由传图片type=1，则此图片必须sort=1。
    - `image_type` integer — 图片类型。1-主图,2-细节图,5-方块图,6-色块图。 需要提供哪些类型的图片、数量限制、各类型图片的尺寸要求，请参考商品图片方案了解详细信息。
    - `image_url` string — 图片链接。 必须为SHEIN格式的URL，可通过外链转换或本地图片上传获取。
- `multi_language_desc_list` object[] — 商品描述列表（支持多语言） 编辑商品信息时，如果不传字段代表清空数据。
  - `language` string **required** — 语种。 若提供描述则必须提供默认语种，默认语种需通过商品发布规范API获取default_language。
  - `name` string **required** — 多语言描述，最多5000个字符。请不要输入html内容，不支持emoji和特殊符号（校验正则： .*[\\ud800\\udc00-\\udbff\\udfff\\ud800-\\udfff].*）
- `multi_language_name_list` object[] **required** — 商品名称列表（支持多语言）
  - `language` string **required** — 语种。 若提供描述则必须提供默认语种，默认语种需通过商品发布规范API获取default_language。
  - `name` string **required** — 商品名称。不支持emoji。 默认语种下的名称长度限制：至少2个字符，最大字符数需查询商品发布规范接口，入参category_id后获取default_language_title_max_length（不同商品分类、不同语种下字符上限不同）。 非默认语种下的名称长度限制：至少2个字符，最多1000字符
- `product_attribute_list` object[] **required** — 商品属性列表。 此列表只能入参attribute_type=3/4的属性。属性使用方式请参考商品属性文档。 编辑商品信息时，如果不传字段代表清空属性。
  - `attribute_extra_value` string — 属性值（手动输入类型）。 当属性的输入方式attribute_mode=0/4时，需要在此处入参。支持输入正整数、文字 当attribute_type=3，且attribute_mode=4（下拉多选+手动输入）时，同属性ID下多个属性值的手动输入值之和必须=100。例如成分属性，A成分含10，B成分含90。
  - `attribute_id` int64 **required** — 属性ID。 商品属性中仅可入参attribute_type=3/4的属性。 必填商品属性有2类：一是attribute_status=3的属性，通过店铺可用属性确认；二是因选了A属性导致B属性必填的关联属性，通过查询关联属性填写规则确认。
  - `attribute_value_id` int64 **required** — 属性值ID。当属性的输入方式attribute_mode=1/3/4时，需要在此处入参。 当attribute_mode=3（下拉单选）时，代表属性id下只能有1个属性值id；当attribute_mode=1（下拉多选）/4（下拉多选+手动输入）时，代表属性id下可以有N个属性值id，多选时每个属性值需要以单独一组数据形式入参，此字段不支持数组，最多可选属性值个数通过属性的attribute_input_num判断。
- `site_list` object[] — 上架站点。 可用模式：自运营、半托管、POP。 新发布商品/在已发布下新增SKC时必须传，编辑时不可传。
  - `main_site` string — 主站点。 通过[查询店铺可售站点和站点币种]API获取到的字段mainSite的值
  - `sub_site_list` string[] — 子站点。 商品上新必填，通过【查询店铺可售站点和站点币种】API获取到的字段【siteAbbr】的值，只能使用site_status=1（启用状态）的站点。
- `product_video_list` object[] — 商品视频。视频需先通过平台转换后才能使用，商品视频绑定在站点维度，每个站点只允许绑定一个视频。视频的使用方式，详见文档。
  - `sites` string[] — 子站点。一个视频可以绑定多个站点，但一个站点只能绑定一个视频。
  - `video_url` string — 视频链接。视频需先通过平台转换后才能使用，商品视频绑定在站点维度，每个站点只允许绑定一个视频。视频的使用方式，详见文档。
- `size_attribute_list` object[] — 尺码表。尺码属性复杂，请参考商品属性文档。当可用属性中有必填尺码属性时，尺码表必传。（type=2&status=3） 编辑商品信息时，如果不传字段代表清空属性。
  - `attribute_id` int64 — 属性ID。 此字段只能入参attribute_type=2的属性。存在必填的尺码属性，attribute_status=3为必填属性，通过店铺可用属性确认；
  - `attribute_value_id` int64 — 属性值ID。 尺码属性不需要传此值，需要在attribute_extra_value给值。
  - `attribute_extra_value` string — 属性值（手动输入类型）。 当属性的输入方式attribute_mode=0/4时，需要在此处入参。仅支持输入正整数。
  - `relate_sale_attribute_id` int64 — 关联的销售属性ID。 尺码属性可与销售属性关联，形成尺码表。注意：只能关联sku维度销售属性。例如尺码：尺码属性：长度，销售属性:尺寸-S，组合后才是完整尺码表。
  - `relate_sale_attribute_value_id` int64 — 关联的销售属性值ID。注意：只能关联sku维度销售属性。
  - `relate_sale_attribute_value` string — 关联的自定义属性值。当SKU的属性值为自定义属性值时，在此处入参，内容需要和SKU属性值保持一致。如果SKU属性值中使用value形式，则此处也必须用value。 使用方式详见文档。
- `skc_list` object[] **required** — skc列表。 一个spu下最多40个skc。 当主销售属性填写规则=不填时（/open-api/goods/query-attribute-template中，main_attribute_status=1），一个SPU下只能有一个SKC，
  - `image_info` object **required** — SKC图片列表。 新旧图片方案的图片上传要求不同，请参考商品图片方案确认SKC层级图片需要哪些图片类型、数量限制、尺寸要求。 编辑商品信息时，如果不传字段代表清空数据。
    - `image_group_code` string — 图片组编码。 新发布商品/在已发布下新增SKC时不可传，编辑必传。通过查询SPU详情获取。
    - `image_info_list` object[] **required** — 图片列表
      - `image_item_id` long — 由平台生成的图片唯一编码。 新发布商品/在已发布下新增SKC时不可传，编辑时部分情况必传，请参考入参示例
      - `image_sort` integer **required** — 图片序号。 同个图片组内序号值不可重复。注意image_type=1的图片sort必须为1。
      - `image_type` integer **required** — 图片类型。1-主图（最多1张）,2-细节图（最多10张）,5-方块图,6-色块图(色块图单skc非必填，多skc必填)。 需要提供哪些类型的图片、数量限制、各类型图片的尺寸要求，请参考商品图片方案了解详细信息。
      - `image_url` string **required** — 图片链接。 必须为SHEIN格式的URL，可通过外链转换或本地图片上传获取。
  - `sale_attribute` object **required** — SKC销售属性。 新发布SPU/在SPU下新增SKC时必传，编辑必传且不可修改。一个商品必有且只有1个SKC销售属性。 销售属性通过/open-api/goods/query-attribute-template获取，SKC只能入参attribute_type=1且 attribute_label=1的属性。若有必填销售属性（attribute_status=3），则必填。当主销售属性填写规则=不填时（main_attribute_status=1），SKC销售属性必填且只能填【默认】。
    - `attribute_id` int64 **required** — 销售属性ID
    - `attribute_value_id` int64 **required** — 销售属性值ID
    - `custom_attribute_value` string — 自定义属性值。使用方式详见文档。 仅在销售属性ID支持自定义属性值时才可入参，是否支持可通过/open-api/goods/get-custom-attribute-permission-config确认。 属性值要求：字符数50以内；支持半角符号，不可输入全角符号；不支持unicode，检验表达式可参考：String emojiPattern = "[\\uD83C-\\uDBFF\\uDC00-\\uDFFF\\u2600-\\u27ff]"
    - `language` string — 自定义属性值的语种。 仅支持入参1个语种，支持的语种：en、zh-cn、fr、es、it。如果ERP不传多语言内容，平台会做系统翻译。
  - `skc_name` string — 平台生成的SKC唯一编码。 新增场景不能传，编辑场景若是更新已发布SKC则必传，若是新增SKC则不用传。
  - `supplier_code` string **required** — 商家侧SKC维度货号，最多200个字符
  - `skc_title` string — skc维度商品标题（不推荐使用此字段，建议使用skc_multi_language_name_list） 不是所有商家均可填写，需通过商品发布规范接口确认，"field_key":"skc_title","show":"show"时可传，"required":"true"时必填。入参的内容将作为skc标题的默认语种录入。编辑时不传字段代表清空数据。
  - `skc_multi_language_name_list` object[] — SKC维度标题多语言列表。若入参则必须提供skc的默认语种信息 通过/open-api/goods/query-publish-fill-in-standard确认以下信息。 1、是否允许填写，"field_key":"skc_title","show":"show"时可传，"required":"true"时必填。 2、可入参的语种范围，以及每个语种的最大字符数（含空格），language_title_max_length_list确认
    - `language` string — 语种。例如英文-en。
    - `name` string — 语种下标题。
  - `sku_list` object[] **required** — sku列表。一个skc下最多400个sku。 1、如果SKC下没有SKU（只有颜色无尺码），依旧要给sku列表数据，sku的销售属性按空处理，但此时一个SKC下只能有1个SKU 2、各个SKC下的SKU，销售属性和属性值的数量需保持一致。例如颜色/红-尺码S、尺码M，颜色/白-尺码S、尺码
    - `cost_info` object — SKU供货价 可用应用模式：半托管、全托管。新发布商品/新增SKCSKU时必传，编辑时不可传。若需要更新已审核通过的SKU供货价，需调用【更新供货价】API修改。
      - `cost_price` string — 供货价格。最多2位小数点。数字在0-100000之间。不可输入负数。
      - `currency` string — 币种缩写。 商家可用币种是商品发布规范的【currency】
    - `height` string **required** — 含包装尺寸：高度。支持输入正数，最多2位小数。 不传单位length_width_height_unit时，单位默认为cm。
    - `length` string **required** — 含包装尺寸：长度。支持输入正数，最多2位小数。 不传单位length_width_height_unit时，单位默认为cm。
    - `width` string **required** — 含包装尺寸：宽度。支持输入正数，最多2位小数。 不传单位length_width_height_unit时，单位默认为cm。
    - `weight` double **required** — 含包装的重量。数值必须大于0，允许入参小数，最多2位小数点。 不传重量单位weight_unit，单位默认为g。
    - `weight_unit` string — 重量单位。可输入的单位需查询发布规范接口获取（不同分类可用单位不同） 全量枚举值为：g / lb / Oz。不传值时默认为g
    - `length_width_height_unit` string — 长宽高单位。可输入的单位需查询发布规范接口获取（不同分类可用单位不同） 全量枚举值：cm / Inch / Ft，不传时默认为 cm
    - `mall_state` integer **required** — sku商城销售状态。 1、在售；2、停售；注意：如果sku设置为停售，不会保存该sku的库存数量，库存数量会在商家后台显示为空
    - `sku_code` string — 平台生成的SKU唯一编码。 新发布商品/在已发布商品下新增SKU时不可传，编辑已有SKU时必传
    - `stop_purchase` integer — 采购状态（仅全托管可使用且必填） 1：可采，2：停采
    - `image_info` object — SKU图片列表。 所有商品在均可上传SKU图片，仅支持提供1张图片。符合以下任意条件时必填：1、SKC下某个SKU有图，则SKC下所有SKU都需要传图。2、当SKU的件数值≥2时，此SKU图必传，这条规则也会触发1。 编辑商品信息时，如果不传字段代表清空数据。
      - `image_group_code` string — 图片组编码。 新发布商品/在已发布下新增SKC时不可传，编辑必传。通过查询SPU详情获取。
      - `image_info_list` object[] — 图片列表。 需要提供哪些类型的图片、数量限制、各类型图片的尺寸要求，请参考商品图片方案了解详细信息。
        - `image_item_id` int64 — 由平台生成的图片唯一编码。 新发布商品/在已发布下新增SKC时不可传，编辑时部分情况必传，请参考入参示例
        - `image_sort` integer — 图片序号。 同个图片组内序号值不可重复。若由传图片type=1，则此图片必须sort=1。
        - `image_type` integer — 图片类型。SKU图仅支持image_type=1。图片要求如下： ● 像素1340px*1785px；或宽高比例1:1，像素范围900px-2200px ● 格式JPG/JPEG/PNG ● 大小≤3MB
        - `image_url` string — 图片链接。 必须为SHEIN格式的URL，可通过外链转换或本地图片上传获取。
    - `supplier_sku` string **required** — 商家维护的SKU编码。 supplier_sku在店内要求唯一，不可重复。1个supplier_sku只对应1个平台sku，最多200个字符。可通过接口确认输入的值在店铺内是否已存在：/open-api/goods/product/check-supplierSku-repeated
    - `supplier_barcode` object — 商家条码。仅部分商家可用，需通过接口确认：/open-api/goods/query-publish-fill-in-standard，响应中的supplier_barcode的show=true代表可填。 非必填，若是更新场景，传null=不更新，传""=清空，传具体值=覆盖更新.
      - `barcode` string — 商品条码。不论哪种条码类型都仅支持数字，最多32位。 同SKC下的SKU中，条码不可重复。
      - `barcode_type` string — 条码类型。枚举值：EAN、UPC
    - `competing_product_link` string — 商品信息参考链接。 部分商家必填，通过商品发布规范接口确认，"field_key":"reference_product_link","required":"true"时必填，"show":"false"时不可传。链接字符长度不超过300。编辑时不穿字段代表清空数据。
    - `price_info_list` object[] **required** — 售价信息（仅自运营、POP使用） 新发布商品/新增SKCSKU时必传，编辑时不可传。更新已发布SKU价格需通过【更新商品售价】调整。 售价按上架站点维度提供。
      - `base_price` double **required** — 原价。 价格必须大于0，最多2位小数，部分币种仅允许整数/整百，各币种的精度要求详见FAQ。原价必须大于特价。
      - `currency` string **required** — 币种缩写。 币种和站点绑定，例如美国站点币种给USD，各站点的币种通过查询站点币种获取。
      - `special_price` double — 特价。 价格必须大于0，最多2位小数，部分币种仅允许整数/整百，各币种的精度要求详见FAQ。特价必须小于原价。 注意：2026年5月8日起，商品的原价、特价将合并为一个价格字段“售价”，API入参允许传入原价和特价，但会优先取特价为售价，无特价取原价。
      - `sub_site` string **required** — 站点（子站点）。 店铺可上架的站点范围通过查询站点币种获取。此处用site_status=1（启用）的site_abbr
    - `site_rrp_info_list` object[] — sku维度建议零售价。使用方式详见文档： https://open.sheincorp.com/documents/system/bf5a59ca-d378-4417-a359-f07cc89bf96b
      - `currency` string — 站点币种
      - `price` double — 建议零售价格，不同币种的精度要求不同，精度要求参考FAQ
      - `site_abbr` string — 站点缩写。 分站点规则下填写站点名，不分站点规则下不用写站点
      - `type_one_proof` object — 类型一证明材料
        - `attachments` string[] — 证明材料附件列表，图片或PDF的URL， 上传材料不能超过6个。 URL需要使用SHEIN链接，使用接口转换获取：/open-api/goods/discuss/upload-discuss-file
        - `proof_link` string — 网站地址，不超过1000个字符
      - `type_two_proof` object — 类型二证明材料
        - `attachments` string[] — 证明材料附件列表，图片或PDF的URL， 上传材料不能超过6个。 URL需要使用SHEIN链接，使用接口转换获取：/open-api/goods/discuss/upload-discuss-file
        - `proof_link` string — 网站地址，不超过1000个字符
    - `sale_attribute_list` object[] — SKU销售属性列表。 只能入参attribute_type=1 且 attribute_label=0/1的属性。attribute_status=3为必填属性，需通过店铺可用属性确认； SKC下无SKU时，销售属性给空；若有SKU，最多有2个属性，且不同SKC下SKU属性数量需相同。新发布商品/新增SKC时必传，编辑场景必传但不可修改。
      - `attribute_id` int64 — 销售属性ID
      - `attribute_value_id` int64 — 销售属性值ID
      - `custom_attribute_value` string — 自定义属性值。使用方式详见文档。 仅在销售属性ID支持自定义属性值时，才可在此字段内入参，可通过/open-api/goods/get-custom-attribute-permission-config确认。 属性值要求：字符数50以内；支持半角符号，不可输入全角符号；不支持unicode，检验表达式可参考：String emojiPattern = "[\\uD83C-\\uDBFF\\uDC00-\\uDFFF\\u2600-\\u27ff]"
      - `language` string — 自定义属性值的语种。 支持的语种：en、zh-cn、fr、es、it。如果ERP不传多语言内容，平台会做系统翻译。
    - `sku_scope_attribute_list` object[] — SKU维度商品属性。 可通过/open-api/goods/query-attribute-template获取，date_data_dimension=3的属性是SKU维度商品属性。
      - `attribute_id` int64 — 属性id
      - `attribute_value_id` int64 — 属性值id
      - `attribute_extra_value` string — 属性值（手动输入值）
    - `stock_info_list` object[] **required** — 库存信息 新发布商品/新增SKC时必传，编辑场景不可传。更新库存使用修改库存（自运营&半托）、采购商库存更新（全托管）处理。
      - `inventory_num` integer **required** — 商品总库存数，数值范围[0,99999]
      - `supplier_warehouse_id` string — 商家仓库ID 。 当店铺有多个仓库，则该字段必填，可通过【商家仓库列表查询】API获取
      - `supplier_warehouse_name` string — 商家仓库名称。 可通过【商家仓库列表查询】API获取。
    - `quantity_info` object — sku维度件数信息 此接口入参字段“filled_quantity_to_sku”="true"时，才可以在此字段中传值。更多件数入参示例参考FAQ
      - `quantity_type` integer — 件数类型。1-单件 2-同品多件 3-混合套装（和suit_flag的定义的状态无关） 已审核通过的SKU不可修改件数信息。
      - `quantity_unit` integer — 件数单位。1-件 2-双 3- 套 相同SKC下所有的SKU，件数单位必须保持一致。已审核通过的SKU不可修改件数信息。
      - `quantity` integer — 件数值。 已审核通过的SKU不可修改件数信息。
    - `package_type` string — sku维度包装类型。此接口入参字段fill_configuration_tags中填写PACKAGE_TYPE_TO_SKU，则字段可填写，可传0-4； 枚举值：0:清空包装 1：软包装+软物，2：软包装+硬物，3：硬包装，4：真空）。
    - `minimum_stock_quantity` string — 最小备货数量。 仅支持输入整数，范围：[1，1000000] 。 能否传值需通过商品发布规范接口确认，"field_key":"minimum_stock_quantity","required":"true"时必填，"show":"false"时不可传
  - `suggested_retail_price` object — 建议零售价。非所有商家可用，能否传值需通过商品发布规范接口确认，"field_key":"suggest_price","required":"true"时必填，"show":"false"时不可传 新发布商品/新增SKC时可传，编辑场景时不能传。
    - `currency` string — 币种缩写。 可用的币种清单：USD, CNY, EUR, SAR, AED, CAD, MXN, HKD, VND, THB, GBP, INR, BRL, TRY, NZD。目前无接口动态查询可用币种。
    - `price` double — 价格。 仅支持正数，不可等于0，最多2位小数（日元不支持小数）。
  - `site_detail_image_info_list` object[] — 站点详情图列表。 图片要求：上传3:4图片，像素大于900px图片，最多可支持10张。 部分商家不可传图，需查询商品发布规范，若"field_key": "product_detail_pic"中的show为false，代表不可传图。
    - `image_group_code` string — 图片组编码。 新增场景不能传，编辑场景更新已发布SKC时必传（如果审核失败则不需要传）。通过查询SPU详情获取。
    - `site_abbr_list` string[] — 站点列表
    - `image_info_list` object[] — 图片信息
      - `image_item_id` string — 首次新增详情图不用传，已有详情图进行修改要传图片组ID
      - `image_sort` integer — 排序
      - `image_url` string — 图片链接 必须为SHEIN格式的URL，可通过外链转换或本地图片上传获取。使用type=7进行转换。
  - `proof_of_stock_list` object[] — 库存证明。 部分商家必填，需通过商品发布规范接口确认，"field_key":"proof_of_stock","required":"true"时必填，"show":"false"时不可传 支持image、PDF格式文件，大小不超过3M，图片/文件总数不超过1个。
    - `file_name` string — 文件名
    - `type` string — 文件类型。 1: Image; 2: PDF
    - `url` string — 文件链接。
  - `shelf_require` string — 是否强制到货SHEIN仓才上架。0:否，1:是。 全托管模式必填，其他模式是否必填需通过商品发布规范接口确认，"field_key":"shelf_require","required":"true"时必填，"show":"false"时不可传。
  - `shelf_way` string — 上架方式。1-自动上架；2-定时上架。 全托管和半托管商家必填。
  - `hope_on_sale_date` string — 期望上架时间。 当shelf_way=2-定时上架时，hope_on_sale_date必填，否则不填；时间给到时分秒，按北京时间给值，e.g.:2022-03-21 00:00:00。
- `sale_attribute_sort_list` object[] — 销售属性排序。 设置消费者商品详情页面上属性值的展示顺序，请调用【商品发布字段规范（含默认语种）】API，根据字段support_sale_attribute_sort判断次销售属性是否支持排序，主销售属性默认都是支持排序；
  - `attribute_id` int64 **required** — 属性名ID
  - `in_order_attribute_value_id_list` int64[] — 属性值ID排序列表。 列表内按期望顺序排列，以确保商品详情页面的顺序与传入参数中的属性值顺序一致。
  - `in_order_attribute_value_list` object[] — 排好序的属性值ID/自定义属性值备注列表。如果属性下有自定义属性值，需用这个字段，属性值用哪个形式就入参下面的哪个字段，按排序输入即可。 使用方式详见文档。
    - `attribute_value_id` string — 属性值ID
    - `custom_attribute_value` string — 自定义属性值的内容。入参内容必须和销售属性中填写的属性值一模一样。
- `sample_info` object — 样品信息。 能否传值需通过商品发布规范接口确认，"field_key":"sample_spec","required":"true"时必填。当样品信息必填时，最外层的size_attribute_list也需要传。
  - `sample_spec` object — 样品规格
    - `main_spec` object — 样品的主销售属性信息。
      - `attribute_id` long — 主销售属性id
      - `attribute_value_id` long — 主销售属性值id
      - `attribute_value_name` string — 主销售属性的自定义属性值
    - `sub_spec_list` object[] — 样品的次销售属性信息；常见的有size
      - `attribute_id` string — 次销售属性id
      - `attribute_value_id` string — 次销售属性值id
      - `attribute_value_name` string — 次销售属性的自定义属性值
  - `sample_judge_type` integer — 审版类型(2:大货样衣)，固定给2
  - `reserve_sample_flag` integer — 是否留样(1:是;2:否)，固定给2
  - `spot_flag` integer — 是否现货(1:是;2:否)

**Response body**
- `bbl` object — bbl
  - `info` object — 
    - `*` object[] — 
- `code` string **required** — Result(success: 0)
- `info` object — 
  - `pre_valid_result` object[] — 校验结果描述
    - `form` string — 拦截原因所属的模块
    - `messages` string[] — 校验不通过原因
    - `module` string — 拦截原因所属的字段
  - `mcc_valid_result` object[] — 平台治理模块。
    - `message` string — message
    - `type` integer — 错误原因类型。1:预警;2:拦截
  - `filtered_result` object[] — 系统基于规则会过滤一些无效数据
    - `scene` string — 过滤场景
    - `message` string — 具体信息
  - `spu_name` string — 发布成功后返回spu_name，后续查询商品或编辑商品时均会使用。
  - `skc_list` object[] — skc list
    - `skc_name` string — 发布成功后返回skc_name
    - `sku_list` object[] — sku list
      - `sku_code` string — 发布成功后返回sku_code
      - `supplier_sku` string — supplier sku
  - `success` boolean — 校验结果
  - `version` string — 审核版本号。 对应查询审核状态接口中的入参version。
- `msg` string — Error description, success: OK
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "success": true, "spu_name": "MM2412222464", "skc_list": [ { "skc_name": "sMM24122224647569", "sku_list": [ { "sku_code": "I7be1tn2tfoo", "supplier_sku": "sc_eu20241127001ss241113986146541TEST2" } ] } ], "version": "SPMP241222341208032", "pre_valid_result": null, "mcc_valid_result": null, "extra": {} }, "bbl": null, "traceId": "3acb2f3aa7649de9" }


## POST `/open-api/goods-publish-quotas/detail` — 查询商家发品额度
Doc id 3002025 · updated 2026-09-04 10:21:42 · QPS 60

商家能否发品的条件之一：发品额度，每个商家每个月会定时更新额度。发品额度指：当前周期内可累计的发布且审核成功的SKC总数量。只要SKC审核通过，即使下架或删除都无法恢复发品额度。 建议开发者在提交发品信息前，先查询发品额度（SKC维度），如果本次提交的SKC数超过发品额度，则提醒商家删减SKC。 发品额度管控中存在“品牌豁免”情况，即如果商品是指定品牌的，则商品不计入发品额度，当商家发布品牌商品时，可在入参中加品牌进行查询。

**Request body**
- `brand_code` string — 品牌code

**Response body**
- `code` string **required** — 响应编码 成功：0
- `msg` string — 错误描述,成功：OK
- `info` object — 商家可发品数查询响应
  - `isControlled` boolean — 是否管控发品额度。 部分情况不管控发品额度，若=false，则代表发品SKC数量无限制。若=true，则需要根据下方availableQuota进行判断。
  - `totalQuota` integer — 当前周期内发品总额度。isControlled=false时，值为null。
  - `availableQuota` integer — 剩余可发品数。isControlled=true时，此值必须大于0时才能发品。isControlled=false时，值为null。
  - `usedCount` integer — 已发品数。isControlled=false时，值为null。
- `traceId` string — 追踪码

**Response example (trimmed)**



## POST `/open-api/goods/query-publish-fill-in-standard` — 商品发布字段规范
Doc id 3002044 · updated 2026-09-24 11:47:20 · QPS 40

每个店铺在各个分类下有不同的商品发布字段填写规范（要求）。建议在调用商品发布接口前，先调用此接口。本接口可查询的要求范围包括： 1、商品标题和商品描述的必填默认语种（default_language） 2、商品发布时是否必传竞品链接和库存证明（reference_product_link和proof_of_stock） 3、商品发布时是否必传样品信息（sample_info） 4、商品发布时是否必传品牌（brand_code） 5、商品发布时是否必传skc标题（skc_title） 6、半托管和全托管的供货价币种（currency） 7、商品是否支持sku和spu维度的图片（picture_config_list） 8、商品发布时是否必传最小备货数量（minimum_stock_quantity） 9、商品是否支持上传详情图（product_detail_picture） 10、商品是否支持在SKU维度传件数（quantity_info) 11、商品是否支持传SKC建议零售价（suggest_price） 12、商品是否支持填写商家条码（supplier_barcode） 13、商品是否支持填写SKU包装类型（package_type） 14、商品是否支持上传IP信息（ip_character） 15、是否支持上传视频（product_video）

**Request body**
- `category_id` long — 末级分类id。查询以下信息的填写规范时需要入参末级分类ID: 分类是否支持SPU维度图片、样品信息、SKU包装类型、SKU维度件数、站点详情图、标题默认语种的最大字符数、分类下SKU图是否必传
- `spu_name` string — SHEIN生成的SKC编码。 该入参仅用于查询某个SPU当前是否正在使用图片新方案，其它场景不需要传；使用场景较少。

**Response body**
- `bbl` object — bbl
  - `info` object — 
    - `*` object[] — 
  - `npid` string — 
- `code` string **required** — result(success: 0)
- `info` object — 
  - `fill_in_standard_list` object[] **required** — 商品发布接口中字段的填写规范列表。 每个field_key值会对应发布接口中的一个入参字段，可确认某个入参能否传值、是否必传。
    - `field_key` string **required** — 规范内容。以下是此接口枚举值 - 对应的发布接口入参字段名 1、reference_product_link - competing_product_link 2、sample_spec - sample_info 3、proof_of_stock - proof_of_stock_list 4、shelf_require - shelf_require 5、brand_code -brand_code 6、skc_title - skc_title 7、minimum_stock_quantity - minimum_stock_quantity 8、product_detail_picture - site_detail_image_info_list 9、quantity_info - filled_quantity_to_sku和quantity_info 10、suggest_p
    - `module` string **required** — 该模块是对应shein后台发品页面的模块，对应以下模块: 1、基本信息 2、供应信息 3、参考信息 4、样品信息
    - `required` boolean **required** — field key中内容是否必填。 true-必填，false非必填
    - `show` boolean **required** — field key中内容是否可传。 true可传，false不可传（传了反而会报错）。
  - `currency` string **required** — 商品供货价币种。 半托管和全托管使用，在发布接口的cost_info -> currency 中使用。
  - `default_language` string **required** — 商家的默认语言。 在发布接口的multi_language_desc_list、multi_language_name_list中使用。默认语种的商品名称必填，
  - `default_language_title_max_length` integer — 商品标题的默认语种的最大字符数。 平台从26年6月开始对默认语种字符数进行管控，不同商品分类+语种，默认语种的字符数限制不同。请入参category_id后获取最大字符数。
  - `language_title_max_length_list` object[] — 商品标题的所有语种的字符数限制（含默认语种）
    - `language` string — 语种
    - `max_length` double — 语种的最大字符数（含空格）
  - `picture_config_list` object[] — 查询店铺是否支持SPU、SKC、SKU维度上传图片
    - `field_key` string — 字段Code
    - `is_true` boolean — 枚举：是/否
  - `support_sale_attribute_sort` boolean — 该字段判断是否支持次销售属性值排序；主销售属性值默认都支持排序
  - `support_duplicate_sale_attr_value` boolean — 判断主销售属性的属性（即SKC的属性值）值是否允许重复。 true=可重复，例如skc1：颜色-红色，skc2：颜色-红色 false=不可重复。
  - `supplier_code_in_spu_dimension` boolean — 判断supplier_code是否绑定在SPU维度。 true=spu维度，发品接口中货号入参到最外层的supplier_code false=skc维度，发品接口中货号入参到skc_list下的supplier_code
- `msg` string — 错误描述， success: OK
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "fill_in_standard_list": [ { "module": "reference_info", "field_key": "reference_product_link", "required": false, "show": false }, { "module": "reference_info", "field_key": "proof_of_stock", "required": false, "show": false }, { "module": "basic_info", "field_key": "skc_title", "required": false, "show": true }, { "module": "supplier_info", "field_key": "minimum_stock_quantity", "required": false, "show": false }, { "module": "sales_info", "field_key": "shelf_require", "required": false, "show": false }, { "module": "basic_info", "field_key": "brand_code", "required": true, "show": true } ], "default_language": "en", "picture_config_list": [], "currency": "GBP", "support_sale_attribute_sort": null }, "bbl": null, "traceId": "19291dc98a3812a8" }


## POST `/open-api/goods/query-attribute-template` — 店铺查可选属性
Doc id 3002046 · updated 2026-10-09 11:18:49 · QPS 80

支持查询店铺可用属性。平台内不同店铺在各个类目下可用的属性不同，因此建议按店铺维度更新数据。同时因平台规则可能会变更，如增加销售属性，修改属性是否必填等，建议一周更新一次。 属性包括：商品属性、主销售属性（skc）、次销售属性（sku）、尺码表属性，属性规则复杂，可查看SHEIN商品属性介绍了解详细对接方式。

**Request body**
- `product_type_id_list` int64[] **required** — 类型id集合，单次调用最多支持10个类型id

**Response body**
- `bbl` object — bbl
  - `info` object — 
    - `*` object[] — 
- `code` string **required** — Result(success: 0)
- `info` object — 
  - `data` object[] — 
    - `attribute_infos` object[] — 某个product_type下属性列表。 建议查看SHEIN商品属性介绍了解更多对接细节。
      - `attribute_id` long — 属性id
      - `attribute_name` string — 属性id的名称。常见的销售属性有颜色、尺码；常见的商品属性有产品特征、产品功能、是否需要电源等
      - `attribute_is_show` int64 — 属性是否会在消费者端显示；1-展示，2-不展示
      - `attribute_type` int64 — 属性类型。决定属性在商品发布接口中哪个字段内入参。 1-销售属性（在skc_list和sku_list入参）；2-尺寸属性（在size_attribute_list传参），3-成分属性（需要同时结合data_dimension的值，判断在发品接口的入参字段），4-普通属性（需要同时结合data_dimension的值，判断在发品接口的入参字段）
      - `attribute_label` int64 — 主销售属性（SKC属性标签）。只有主销售属性才可在skc_list中传参。 1-代表是主销售属性，主销售属性也可用于次销售属性; 0: 不是主销售属性。
      - `attribute_mode` int64 — 属性值的录入方式。 0 - 手工输入属性值，常见于尺寸属性，只可输入正整数，需在attribute_extra_value中入参； 1-下拉多选，即属性下可以有多个属性值，需在attribute_value_id中入参； 2-销售属性专用，下拉单选，需在attribute_value_id中入参； 3-下拉单选，需在attribute_value_id中入参 4-下拉多选+手工输入参数，需在attribute_value_id和attribute_extra_value中入参
      - `attribute_input_num` integer — 属性值个数限制。 当attribute_mode=1时，最多可选的属性值个数，0代表无限制。
      - `attribute_status` int64 — 属性是否必填。 1-不可填写（属性可能已废弃）；2-选填；3-必填。必填属性如果不填，则会报错；
      - `attribute_remark_list` integer[] — 属性标识。说明属性归属于什么场景。1:重要,2:合规,3:质量,4:关务
      - `data_dimension` integer — 商品属性的绑定维度（attribute_type=3/4）。 1-skc维度，在发品接口的product_attribute_list中入参 3-sku维度，在发品接口的sku_scope_attribute_list中入参
      - `attribute_value_info_list` object[] — 属性值列表
        - `attribute_value` string — 属性值的具体内容
        - `attribute_value_id` long — 属性值id
        - `is_show` int64 — 是否展示
        - `is_custom_attribute_value` boolean — 是否为自定义属性值。true代表是，false代表否
      - `rule_info_list` object[] — 成分属性或普通属性（attribute_type=3/4）支持手动输入值时（attribute_mode=0/4，即可在发品接口中的product_attribute_list-attribute_extra_value中入参时）需要关注此规则。此字段中给出了手动输入值的填写规则。
        - `condition_operator` integer — 条件运算符(目前只作用于正整数、自然数的位数控制)； 0、空：表示不做控制，1：大于{value}位，2：小于{value}位
        - `condition_type` integer — 校验规则类型。 1-值必须是正整数 2-值必须是连接符，可填符号的详见value 3-值允许输入小数，小数最多支持的位数见value 4-值必须是自然数 (0+正整数) 5-允许输入数字和连接符，数字最多允许2位小数，可填写的连接符见value，多个时逗号分隔，如-,~,/
        - `id` int64 — 校验规则id
        - `value` string — 变量值。不同condition_type时代表意义不同，详细说明见condition_type
      - `supplier_id` long — 商家id（如果值大于0，则表示是自定义属性）
    - `main_attribute_status` long — 类目下主销售属性填写要求。注意：API发品时不论哪种情况，skc的主销售属性必须入参，只是不同填写要求主销售属性可用值不同。 1-不填：主销售属性必须使用【默认】属性。 2-选填：主销售属性可使用【默认】或其他属性。 3-必填：主销售属性不可以使用【默认】属性，只能用其他属性。
    - `product_type_id` long — 商品类型id
  - `meta` object — 
    - `count` integer — 
    - `customObj` object — 
- `msg` string — Error description, success: OK
- `traceId` string — 请求的唯一标识；用于异常报错跟踪

**Response example (trimmed)**
{ "code": "0", "msg": "OK", "info": { "data": [ { "product_type_id": 2512, "business_mode": 1, "attribute_infos": [ { "attribute_id": 87, "attribute_name": "尺寸", "attribute_name_en": "Size", "attribute_is_show": 1, "attribute_source": 1, "attribute_label": 0, "attribute_mode": 2, "data_dimension": 1, "attribute_status": 3, "attribute_type": 1, "business_mode": 1, "is_sample": 1, "supplier_id": 0, "attribute_doc": null, "attribute_doc_image_list": null, "attribute_value_info_list": [ { "attribute_value_id": 474, "attribute_value": "单一尺寸", "attribute_value_en": "one-size", "is_custom_attribute_value": false, "is_show": 1, "supplier_id": 0, "attribute_value_doc": null, "attribute_value_doc_image_list": null, "attribute_value_group_list": null }, { "attribute_value_id": 1448, "attribute_value": "", "attribute_value_en": "", "is_custom_attribute_value": false, "is_show": 1, "supplier_id": 0, "attribute_value_doc": null, "attribute_value_doc_image_list": null, "attribute_value_group_list": null }, { "attribute_value_id": 568, "attribute_value": "S", "attribute_value_en": "S", "is_custom_attribute_value": false, "is_show": 1, "supplier_id": 0, "attribute_value_doc": null, "attribute_value_doc_image_list": null, "attribute_value_group_list": null }, { "attribute_value_id": 417, "attribute_value": "M(中文)", "attribute_value_en": "M", "is_custom_attribute_value": false, "is_show": 1, "supplier_id": 0, "attribute_value_doc": null, "attribute_value_doc_image_list": null, "attribute_value_


## POST `/open-api/goods-specs/check-modify-permission` — 查询是否可修改销售属性
Doc id 3002076 · updated 2026-10-26 10:36:09 · QPS 20

商品发起修改销售属性，需要满足以下所有条件，可通过此接口判断商品是否满足要求。修改销售属性的整体解决方案，请点击查看文档。 1、非成衣、鞋类、胚衣/定制类商品 2、没有SHEIN仓库存，即SHEIN仓库存=0 3、没有审版通过 / 有实物核价记录 4、非复制商品（如搬家、托盘商场景下，被复制出来的商品） 5、商品当前不存在审核中的商品新增/编辑公文，也不可存在审核中的销售属性修改单 6、商品必须是已上新成功，即SPU一定有审核通过的公文

**Request body**
- `spu_name` string **required** — spuName，SHEIN平台的商品编码，必须是已经审核通过的SPU

**Response body**
- `code` string **required** — 响应编码 成功：0
- `info` object — 响应嘻嘻
  - `can_modify` boolean — 是否可以修改销售属性。true=可以修改；false=不可修改
  - `fail_reasons` string[] — 不可修改的原因列表。（can_modify=true 时为空数组，can_modify=false时有值）。可能存在多条原因，每条原因会根据header中的语种翻译为多语言。
- `msg` string — 错误描述,成功：OK
- `traceId` string — 追踪码

**Response example (trimmed)**



## POST `/open-api/goods-specs/update` — 提交修改销售属性
Doc id 3002077 · updated 2026-10-26 11:40:42 · QPS 20

修改销售属性的表单构建较为复杂，请参考详细的解决方案，点击查看。

**Request body**
- `size_attribute_list` object[] — 尺寸属性列表。覆盖逻辑，不传或传空代表清空尺码数据，若传值则需要传完整的尺码数据。
  - `attribute_extra_value` string **required** — 尺寸属性值
  - `attribute_id` int64 **required** — 尺寸属性ID
  - `relate_sale_attribute_custom_attribute_value` string — 关联的次销售属性使用自定义销售属性值时，在此输入自定义销售属性值
  - `relate_sale_attribute_id` int64 **required** — 关联的次销售属性ID
  - `relate_sale_attribute_value_id` int64 — 关联的次销售属性值ID，与 relate_sale_attribute_custom_attribute_value 二选一
- `skc_list` object[] **required** — SKC列表，需提交SPU下当前所有的SKC，不可新增或删除SKC。 具体可修改的场景，详见解决方案
  - `sale_attribute` object **required** — 主销售属性信息
    - `attribute_id` int64 **required** — 属性ID
    - `attribute_value_id` int64 — 属性值ID，与 custom_attribute_value 二选一
    - `custom_attribute_value` string — 自定义属性值文本，与 attribute_value_id 二选一，最长50字符
    - `language` string — custom_attribute_value 的语种
  - `skc_name` string **required** — SKC编码，即SHEIN平台编码
  - `sku_list` object[] **required** — SKU列表，需提交SPU下当前所有的SKU，不可新增或删除SKU 具体可修改的场景，详见解决方案
    - `sale_attribute_list` object[] **required** — 次销售属性列表，无次销售属性传空数组
      - `attribute_id` int64 **required** — 属性ID
      - `attribute_value_id` int64 — 属性值ID，与 custom_attribute_value 二选一
      - `custom_attribute_value` string — 自定义属性值文本，与 attribute_value_id 二选一，最长100字符
      - `language` string — custom_attribute_value 的语种
    - `sku_code` string **required** — SKU编码，SHEIN生成的编码
- `spu_name` string **required** — SPU编码，SHEIN生成的编码

**Response body**
- `code` string **required** — 响应编码 成功：0
- `info` object — 提交修改销售属性响应
  - `flow_sn` string — 修改销售属性审核单号
- `msg` string — 错误描述,成功：OK
- `traceId` string — 追踪Id

**Response example (trimmed)**



## POST `/open-api/goods/searchProduct` — 商品综合查询
Doc id 3001938 · updated 2026-08-03 10:41:33 · pulled 2026-10-27 for SHEIN Listings (the snapshot + the Phase 0 probe read categoryId and the promotion locks from it)

商品列表接口，支持使用各种条件综合查询，查询结果按SPU维度提供，每个SPU下会提供商品的关键信息。  支持的条件：平台编码、商家维护货号、上架状态、类目、发布时间和更新时间；各条件间是且的关系。  返回的信息：各层级的编码和货号、标题属性、主图、上架状态、价格、库存、营销活动锁。

**Request body**
- `pageNum` integer **required** — 分页页码，从1开始
- `pageSize` integer **required** — 分页大小，最大10
- `categoryIds` int64 — 末级分类ID列表，单次最多10个。
- `spuNameList` string — SPU编码列表（平台编码），单次最多10个。
- `skcNameList` string — SKC编码列表（平台编码），单次最多10个。
- `skuCodeList` string — SKU编码列表（平台编码），单次最多10个。
- `skcSupplierCodeList` string — SKC货号列表（商家维护的货号），单次最多10个。
- `supplierSkuList` string — 商家SKU列表（商家维护的SKU货号），单次最多10个
- `skcShelfStatus` integer — SKC上架状态，0:下架 1:上架。待上架和已售罄均属于下架状态。
- `languageList` string — 语种列表，决定商品信息中名称、属性名称、属性值名称返回的语种内容。单次最多入参5个语种，不传时默认返回英语。支持的语种包括：英语:en、法语:fr、西班牙语:es、德语:de、中文简体:zh-cn、泰语:th、巴西葡语:pt-br、日语:ja、韩语:ko
- `createTimeStart` string — SPU的发布时间段（开始时间），格式 yyyy-MM-dd HH:mm:ss。发布时间定义：SPU首次审核通过时间。
- `createTimeEnd` string — SPU的发布时间段（结束时间），格式 yyyy-MM-dd HH:mm:ss。发布时间定义：SPU首次审核通过时间。
- `updateTimeEnd` string — SPU的更新时间段（结束时间），格式 yyyy-MM-dd HH:mm:ss。更新时间定义：SPU下任意SKC的标题、品牌、IP、属性变更导致的更新。不包括价格、库存的更新。
- `updateTimeStart` string — SPU的更新时间段（开始时间），格式 yyyy-MM-dd HH:mm:ss。更新时间定义：SPU下任意SKC的标题、品牌、IP、属性变更导致的更新。不包括价格、库存的更新。

**Response body**
- `code` string **required** — 响应编码 成功：0
- `msg` string — 错误描述,成功：OK
- `info` object — 查询结果
  - `meta` object — 分页元信息
    - `count` integer — 符合查询条件的SPU数量
  - `data` object — SPU列表。默认按SPU发布时间降序排序。
    - `spuName` string — spu编码，平台生成的编码
    - `spuShelfStatus` integer — SPU的上架状态，0:下架 1:上架。待上架和已售罄均属于下架状态。
    - `categoryId` string — 末级类目ID
    - `skcList` object — SKC列表
      - `skcName` string — SKC的平台编码
      - `skcShelfStatus` integer — SKC上架状态，0:下架 1:上架。待上架和已售罄均属于下架状态。
      - `supplierCode` string — SKC的商家货号
      - `skcMainPicUrl` string — SKC主图URL
      - `skcTitle` object — SKC标题列表
        - `language` string — 语种。返回的语种取决于入参中的languageList
        - `title` string — 标题内容
      - `skcSalesAttribute` object — SKC销售属性列表
        - `language` string — 语种。返回的语种取决于入参中的languageList
        - `attributeId` string — 属性ID
        - `attributeName` string — 属性名称
        - `attributeValueId` string — 属性值ID
        - `attributeValueName` string — 属性值名称
      - `skcSiteShelfStatusList` object — SKC的站点维度上架状态。
        - `status` integer — 上架状态，0:下架 1:上架。
        - `subSite` string — 子站点，例如shein-us
      - `activityLockList` object — SKC的各站点营销活动锁定状态。商品参加营销活动后，根据活动要求，会出现无法下架、无法涨价的情况。可通过此字段来判断商品当前能否下架、能否涨价。
        - `site` string — 站点。SKC按站点维度参加营销活动。
        - `shelfLockType` integer — 下架锁。即SKC在此站点能否发起下架。0=无锁，即可下架。当SKC没有参加活动，或参加活动但活动允许下架时会出现0。1=锁定，即不可下架。大多是因为参加的营销活动已启动，活动期间不允许下架。
        - `priceLockType` integer — 涨价锁。即SKC在此站点能否发起调高销售价/成本价。0=无锁，即无限制。当SKC没有参加活动，或参加活动但活动允许调价时会出现0。1=不可涨价但可降价（强校验）。即不允许涨价，涨价就会拦截。2=不可涨价但可降价（仅提醒）。即平台建议不要涨价，涨价不会拦截，但视情况会影响活动效果。
      - `skuList` object — SKU列表
        - `skuCode` string — SKU的平台编码
        - `supplierSku` string — 商家维护的SKU，即发布接口中的supplier_sku
        - `skuSalesAttributeList` object — SKU销售属性列表。如果列表为空，说明商品没有次规格属性。
          - `language` string — 语种。返回的语种取决于入参中的languageList
          - `attributeId` string — 属性ID
          - `attributeName` string — 属性名称
          - `attributeValueId` string — 属性值ID
          - `attributeValueName` string — 属性值名称
        - `costList` object — 成本价列表。仅半托管/全托管模式商家会返回此数据
          - `cost` double — 金额
          - `currency` string — 币种
        - `priceList` object — 售价列表。仅自运营商家返回此数据
          - `site` string — 站点。例如shein-us
          - `currency` string — 币种
          - `basePrice` double — 原价
          - `specialPrice` double — 特价。特价=0，代表商家发布商品时没有维护特价。特价为0时可视为无特价。
        - `inventoryList` object — 库存列表。如果为空，则说明商品在任一仓库都没有维护库存数据
          - `warehouseId` string — 仓库ID
          - `inventoryNum` integer — 库存数量
- `traceId` string — 请求跟踪码


## POST `/open-api/goods/product/partialEdit` — pulled 2026-10-27 for Phase 2 (add sizes)

The ONE write Phase 2 makes (`api/_lib/shein.js` `sheinPartialEditLogged`). Rendered from doc 3002047 (latest version 10); request/response examples are empty on the portal.

### Doc id 3002047 · updated 2026-10-09 19:39:27 · QPS 40

此接口用于编辑已审核通过的商品，支持简化入参实现编辑，提交后商品需要接受平台审核 支持的场景（以下场景可在一次请求中叠加出现）： 1、编辑商品的信息：修改A信息，就只需要传A信息。例如修改某个SKU的supplier_sku，则提供"spu_name + skc_name + sku_code + supplier_sku"即可 2、SPU下新增SKC：可以只传新SKC的信息，提供"spu_name + 新skc的完整skc_list"即可。 3、SPU下新增SKU：可以只传新SKU的信息，提供"spu_name + skc +新sku的完整sku_list"即可。 调用注意事项 1、收到请求后平台会补齐未入参字段后进行商品发布校验，因此编辑时，依旧要确保商品整体数据符合平台要求。例如：编辑时若分类新增必填属性，则需要提供新必填属性；编辑时若某个SKU增加SKU图，则SKC下其他所有SKU也需提交SKU图。 2、此接口调用原则是，某字段不传或传null=字段不更新保留原值，某字段传值=更新为入参值，某字段传""=将字段的值更新为空。 3、编辑商品的信息时，编辑SPU/SKC/SKU下某个信息时，若编辑的字段是object[]，则需要提供字段下完整数据，例如：product_attribute_list中原本有4个属性，需要更新任意信息时，入参需提供"更新后完整的商品属性"。 响应说明 1、修改SPU层级数据时，实际会修改所有SKC相关数据（可理解为所有SKC共享SPU层数据），因此响应用会返回所有SKC的审核公文 2、修改SKC-A 或 SKC-A下的SKU1 或 SKC-A下新增SKU时，响应中会返回SKC-A的审核公文 3、新增SKC-B时，响应中会返回SKC-B的审核公文

**Request body**
- `spu_name` string **required** — 平台生成的SPU唯一编码。必填。
- `category_id` int64 — 末级分类id。
- `product_type_id` int64 — 商品类型id。
- `supplier_code` string — 商家货号，到主规格粒度，最多200个字符
- `brand_code` string — 店铺可用的品牌code。
- `ip_character_list` object[] — 商品IP。目前每个商品仅支持绑定1个IP。 店铺可用的IP可通过接口获取：/open-api/goods/query-ip-list。店铺能否传IP，需通过规范接口确认，"ip_character"的"show": true代表可传。
  - `ip_id` int64 — IP的ID。若传ip_character_list，则ip_id必传。
  - `ip_name` string — IP的英语名称
  - `ip_name_cn` string — IP的中文名称
- `is_spu_pic` boolean — 是否使用新版图片方案。true-用新方案，false-用旧方案。 如果从false切换成true，必须提交新方案中需要的所有层级的所有类型图片。
- `image_info` object — SPU图片列表。 当商品原本就可传SPU图片时才可编辑（即商品原本的is_spu_pic=true）
  - `image_group_code` string — 图片组的唯一编码，由平台生成。
  - `image_info_list` object[] **required** — 图片明细
    - `image_item_id` int64 — 图片的唯一编码，由平台生成。
    - `image_sort` integer — 图片排序。 同个图片组内序号值不可重复。type=1的图片sort必须是1。
    - `image_type` integer — 图片类型。1-主图,2-细节图,5-方块图,6-色块图。 需要提供哪些类型的图片、数量限制、各类型图片的尺寸要求，请参考商品图片方案了解详细信息。
    - `image_url` string — 图片链接。 必须为SHEIN格式的URL，可通过外链转换或本地图片上传获取。
- `multi_language_name_list` object[] — 商品名称列表（支持多语言） 此字段不允许清空，如果编辑时字段传“”会报错。
  - `language` string **required** — 语种。 若传值则必须提供默认语种，默认语种需通过商品发布规范API获取default_language。
  - `name` string **required** — 商品名称，最多1000个字符，不支持emoji。
- `multi_language_desc_list` object[] — 商品描述列表（支持多语言）
  - `language` string **required** — 语种。 若传值则必须提供默认语种，默认语种需通过商品发布规范API获取default_language。
  - `name` string **required** — 多语言描述，最多5000个字符，不支持emoji。
- `product_attribute_list` object[] — 商品属性列表。若更新商品属性信息，则需要提交完整的属性列表。 此列表只能入参attribute_type=3/4的属性。属性使用方式请参考商品属性文档。
  - `attribute_id` int64 **required** — 属性ID。 商品属性中仅可入参attribute_type=3/4的属性。 必填商品属性有2类：一是attribute_status=3的属性，通过店铺可用属性确认；二是因选了A属性导致B属性必填的关联属性，通过查询关联属性填写规则确认。
  - `attribute_value_id` int64 — 属性值ID。当属性的输入方式attribute_mode=1/3/4时，需要在此处入参。 当attribute_mode=3（下拉单选）时，代表属性id下只能有1个属性值id；当attribute_mode=1（下拉多选）/4（下拉多选+手动输入）时，代表属性id下可以有N个属性值id，多选时每个属性值需要以单独一组数据形式入参，此字段不支持数组，最多可选属性值个数通过属性的attribute_input_num判断。
  - `attribute_extra_value` string — 属性值（手动输入类型）。 当属性的输入方式attribute_mode=0/4时，需要在此处入参。支持输入正整数、文字 当attribute_type=3，且attribute_mode=4（下拉多选+手动输入）时，同属性ID下多个属性值的手动输入值之和必须=100。例如成分属性，A成分含10，B成分含90。
- `size_attribute_list` object[] — 尺码属性（尺码表）。 注意：若商品原本有尺码表，在部分编辑时商品下SKU的属性值变多时，必须同时提交新的尺码表数据。例如原本SKU是尺码-S，尺码-M，此次提交时新增了SKU尺码-L，则同时需要提交包含S、M、L的尺码表。尺码入参方式请参考商品属性文档。
  - `attribute_id` int64 **required** — 属性ID。 此字段只能入参attribute_type=2的属性。
  - `attribute_value_id` int64 — 属性值ID。 尺码属性不需要传此值，需要在attribute_extra_value给值。
  - `attribute_extra_value` string — 属性值（手动输入类型）。 当属性的输入方式attribute_mode=0/4时，需要在此处入参。仅支持输入正整数。
  - `relate_sale_attribute_id` int64 — 关联的销售属性ID。 尺码属性可与销售属性关联，形成尺码表。注意：只能关联sku维度属性。例如尺码：尺码属性：长度，销售属性:尺寸-S，组合后才是完整尺码表。
  - `relate_sale_attribute_value_id` int64 — 关联的销售属性值ID。注意：只能关联sku维度属性。
  - `relate_sale_attribute_value` string — 关联的自定义属性值。当SKU的属性值为自定义属性值时，在此处入参，内容需要和SKU属性值保持一致。如果SKU属性值中使用value形式，则此处也必须用value。 使用方式详见文档。
- `sale_attribute_sort_list` object[] — 销售属性排序。 注意：如果商品原本有自定义排序，在部分编辑时新增了SKC或SKU时，需要同时提交完整的排序值。
  - `attribute_id` int64 **required** — 属性名ID
  - `in_order_attribute_value_id_list` int64[] — 属性值ID排序列表。 列表内按期望顺序排列，以确保商品详情页面的顺序与传入参数中的属性值顺序一致。
  - `in_order_attribute_value_list` object[] — 排好序的属性值ID/自定义属性值备注列表。如果属性下有自定义属性值，需用这个字段，属性值用哪个形式就入参下面的哪个字段，按排序输入即可。 使用方式详见文档。
    - `attribute_value_id` int64 — 属性值ID
    - `custom_attribute_value` string — 自定义属性值的内容。入参内容必须和销售属性中填写的属性值一模一样。
- `skc_list` object[] — SKC信息列表。 一个spu下最多40个skc。
  - `skc_name` string — SKC唯一编码，由平台生成。 编辑SKC时必填。
  - `sale_attribute` object — SKC销售属性。 此字段只能入参attribute_type=1 且 attribute_label=1的属性。存在必填的销售属性，attribute_status=3为必填属性，通过店铺可用属性确认；
    - `attribute_id` int64 — 销售属性ID
    - `attribute_value_id` int64 — 销售属性值ID
    - `custom_attribute_value` string — 自定义属性值。使用方式详见文档。 仅在销售属性ID支持自定义属性值时，才可在此字段内入参，可通过/open-api/goods/get-custom-attribute-permission-config确认。 属性值要求：字符数50以内；支持半角符号，不可输入全角符号；不支持unicode，检验表达式可参考：String emojiPattern = "[\\uD83C-\\uDBFF\\uDC00-\\uDFFF\\u2600-\\u27ff]"
    - `language` string — 自定义属性值的语种。 支持的语种：en、zh-cn、fr、es、it。如果ERP不传多语言内容，平台会做系统翻译。
  - `skc_title` string — skc维度商品标题。 部分商家必填，通过商品发布规范接口确认，"field_key":"skc_title","required":"true"时必填，"show":"false"时不可传。提供默认语种的标题即可。编辑时不传字段代表清空数据。
  - `skc_multi_language_name_list` object[] — SKC维度标题多语言列表。若入参则必须提供skc的默认语种信息 通过/open-api/goods/query-publish-fill-in-standard确认以下信息。 1、是否允许填写，"field_key":"skc_title","show":"show"时可传，"required":"true"时必填。 2、可入参的语种范围，以及每个语种的最大字符数（含空格），language_title_max_length_list确认
    - `language` string **required** — 语种。例如英文-en。
    - `name` string **required** — 语种内容
  - `supplier_code` string — 商家侧SKC维度货号，最多200个字符
  - `image_info` object — SKC图片列表
    - `image_group_code` string — 图片组的唯一编码，由平台生成。
    - `image_info_list` object[] **required** — 图片明细
      - `image_item_id` int64 — 图片的唯一编码，由平台生成。
      - `image_sort` integer **required** — 图片排序。 同个图片组内序号值不可重复。type=1的图片sort必须是1。
      - `image_type` integer **required** — 图片类型。1-主图,2-细节图,5-方块图,6-色块图。 需要提供哪些类型的图片、数量限制、各类型图片的尺寸要求，请参考商品图片方案了解详细信息。
      - `image_url` string **required** — 图片链接。 必须为SHEIN格式的URL，可通过外链转换或本地图片上传获取。
  - `site_detail_image_info_list` object[] — SKC站点详情图列表。 传入的均是type=7的图片。
    - `image_group_code` string — 图片组的唯一编码，由平台生成。 编辑时必填，可通过/open-api/goods/spu-info获取。
    - `image_info_list` object[] **required** — 图片明细
      - `image_item_id` int64 — 图片的唯一编码，由平台生成。
      - `image_sort` integer **required** — 图片排序。 同个图片组内序号值不可重复。
      - `image_url` string **required** — 图片链接。 必须为SHEIN格式的URL，可通过外链转换或本地图片上传获取。
    - `site_abbr_list` string[] **required** — 站点列表
  - `suggested_retail_price` object — 建议零售价。非所有商家可用，能否传值需通过商品发布规范接口确认，"field_key":"suggest_price","required":"true"时必填，"show":"false"时不可传 新增SKC时可传，编辑场景时不能传。
    - `currency` string **required** — 币种缩写。 商家可用币种是商品发布规范的【currency】。（目前不支持JPY，可暂用USD代替）
    - `price` double **required** — 价格。 最多2位小数（日元不支持小数）。
  - `shelf_require` string — 是否强制到货SHEIN仓才上架。0:否，1:是。 全托管模式必填，其他模式是否必填需通过商品发布规范接口确认，"field_key":"shelf_require","required":"true"时必填，"show":"false"时不可传。
  - `shelf_way` integer — 上架方式。1-自动上架；2-定时上架。 全托管和半托管商家必填。
  - `hope_on_sale_date` datetime — 期望上架时间。 当shelf_way=2-定时上架时，hope_on_sale_date必填，否则不填；时间给到时分秒，按北京时间给值，e.g.:2022-03-21 00:00:00。
  - `proof_of_stock_list` object[] — 库存证明。 部分商家必填，需通过商品发布规范接口确认，"field_key":"proof_of_stock","required":"true"时必填，"show":"false"时不可传 支持image、PDF格式文件，大小不超过3M，图片/文件总数不超过1个。
    - `file_name` string **required** — 文件名
    - `type` integer **required** — 文件类型。 1: Image; 2: PDF
    - `url` string **required** — 文件链接。
  - `sku_list` object[] — SKU列表。
    - `sku_code` string — SKU唯一编码，由平台生成。 编辑SKU时必填。
    - `sale_attribute_list` object[] — SKU销售属性列表。 只能入参attribute_type=1 且 attribute_label=0/1的属性。attribute_status=3为必填属性，需通过店铺可用属性确认； SKC下无SKU时，销售属性给空；若有SKU，最多有2个属性，且不同SKC下SKU属性数量需相同。新增SKU时必传，编辑场景不可修改。
      - `attribute_id` int64 **required** — 销售属性ID
      - `attribute_value_id` int64 — 销售属性值ID
      - `custom_attribute_value` string — 自定义属性值。使用方式详见文档。 仅在销售属性ID支持自定义属性值时，才可在此字段内入参，可通过/open-api/goods/get-custom-attribute-permission-config确认。 属性值要求：字符数50以内；支持半角符号，不可输入全角符号；不支持unicode，检验表达式可参考：String emojiPattern = "[\\uD83C-\\uDBFF\\uDC00-\\uDFFF\\u2600-\\u27ff]"
      - `language` string — 自定义属性值的语种。 支持的语种：en、zh-cn、fr、es、it。如果ERP不传多语言内容，平台会做系统翻译。
    - `supplier_sku` string — 商家维护的SKU编码。 supplier_sku在店内要求唯一，不可重复。1个supplier_sku只对应1个平台sku，最多200个字符。可通过接口确认输入的值在店铺内是否已存在：/open-api/goods/product/check-supplierSku-repeated
    - `length` string — 含包装尺寸：长度（cm）。 支持输入正数，最多2位小数。
    - `width` string — 含包装尺寸：宽度（cm）。 支持输入正数，最多2位小数。
    - `height` string — 含包装尺寸：高度（cm）。 支持输入正数，最多2位小数。
    - `weight` double — 含包装重量：重量（g）。 支持输入正整数，不可输入0
    - `weight_unit` string — 
    - `length_width_height_unit` string — 
    - `mall_state` integer — sku商城销售状态。 1、在售；2、停售；注意：如果sku设置为停售，不会保存该sku的库存数量，库存数量会在商家后台显示为空
    - `stop_purchase` integer — 采购状态（仅全托管可使用） 1：可采，2：停采
    - `quantity_info` object — sku维度件数信息 若商品原本就有SKU维度件数，在部分编辑新增SKC或SKU时，新增SKU全部需要提供件数。
      - `quantity` integer **required** — 件数值。 已审核通过的SKU不可修改件数信息。
      - `quantity_type` integer **required** — 件数类型。1-单件 2-同品多件。 已审核通过的SKU不可修改件数信息。
      - `quantity_unit` integer **required** — 件数单位。1-件 2-双 相同SKC下所有的SKU，件数单位必须保持一致。已审核通过的SKU不可修改件数信息。
    - `package_type` integer — sku维度包装类型。枚举值：0:清空包装 1：软包装+软物，2：软包装+硬物，3：硬包装，4：真空。 若商品原本就有SKU维度包装类型，在部分编辑新增SKC或SKU时，新增SKU全部需提供包装类型。
    - `supplier_barcode` object — 商家条码。仅部分商家可用，需通过接口确认：/open-api/goods/query-publish-fill-in-standard，响应中的supplier_barcode的show=true代表可填。
      - `barcode` string **required** — 商品条码。不论哪种条码类型都仅支持数字，最多32位。 同SKC下的SKU中，条码不可重复。
      - `barcode_type` string **required** — 条码类型。枚举值：EAN、UPC
    - `image_info` object — SKU图片列表。 若商品原本有SKU图，在部分编辑中新增SKC或SKU时，新增SKU必须全部提供SKU图
      - `image_group_code` string — 图片组的唯一编码，由平台生成。 编辑时必填，可通过/open-api/goods/spu-info获取。
      - `image_info_list` object[] **required** — 图片明细
        - `image_item_id` int64 — 图片的唯一编码，由平台生成。 若提供新图片可不填，若提供旧图片需要填写，可通过/open-api/goods/spu-info获取。
        - `image_sort` integer — 图片排序。 同个图片组内序号值不可重复。type=1的图片sort必须是1。
        - `image_type` integer — 图片类型。 SKU图片仅可传type=1的图片。
        - `image_url` string — 图片链接。 必须为SHEIN格式的URL，可通过外链转换或本地图片上传获取。
    - `price_info_list` object[] — 售价信息（仅自运营、POP使用） 新增SKC/SKU时必传，编辑时不可传。更新已发布SKU价格需通过【更新商品售价】调整。 售价按上架站点维度提供。
      - `base_price` double **required** — 原价。 仅支持数字，最多2位小数（日元不支持小数）。原价必须大于特价。
      - `currency` string **required** — 币种缩写。 币种和站点绑定，例如美国站点币种给USD，各站点的币种通过查询站点币种获取。
      - `special_price` double — 特价。 仅支持数字，最多2位小数（日元不支持小数）。特价必须小于原价。
      - `sub_site` string **required** — 站点（子站点）。 店铺可上架的站点范围通过查询站点币种获取。此处用site_status=1（启用）的site_abbr
    - `cost_info` object — SKU供货价 可用应用模式：半托管、全托管。新增SKCSKU时必传，编辑时不可传。若需要更新已审核通过的SKU供货价，需调用【更新供货价】API修改。
      - `cost_price` string **required** — 供货价格。最多2位小数点。数字在0-100000之间。不可输入负数。
      - `currency` string **required** — 币种缩写。 商家可用币种是商品发布规范的【currency】
    - `stock_info_list` object[] — 库存信息 新增SKC/SKU时必传，编辑场景不可传。更新库存使用修改库存（自运营&半托）、采购商库存更新（全托管）处理。
      - `inventory_num` integer **required** — 商品总库存数。可以为0，
      - `supplier_warehouse_id` int64 — 商家仓库ID 。 当店铺有多个仓库，则该字段必填，可通过【商家仓库列表查询】API获取
      - `supplier_warehouse_name` string — 商家仓库名称。 可通过【商家仓库列表查询】API获取。
    - `competing_product_link` string — 商品信息参考链接。 部分商家必填，通过商品发布规范接口确认，"field_key":"reference_product_link","required":"true"时必填，"show":"false"时不可传。链接字符长度不超过300。编辑时不穿字段代表清空数据。
    - `minimum_stock_quantity` integer — 最小备货数量。 仅支持输入整数，范围：[1，1000000] 。 能否传值需通过商品发布规范接口确认，"field_key":"minimum_stock_quantity","required":"true"时必填，"show":"false"时不可传
- `product_video_list` object[] — 商品视频。视频需先通过平台转换后才能使用，商品视频绑定在站点维度，每个站点只允许绑定一个视频。视频的使用方式，详见文档。
  - `sites` string[] — 子站点。一个视频可以绑定多个站点，但一个站点只能绑定一个视频。
  - `video_url` string — 视频链接。视频需先通过平台转换后才能使用，商品视频绑定在站点维度，每个站点只允许绑定一个视频。视频的使用方式，详见文档。

**Response body**
- `bbl` object — 响应异常时的bbl相关信息
  - `info` object — 
    - `*` object[] — 
  - `npid` string — 
- `code` string **required** — 响应编码 成功：0
- `info` object — 商品编辑校验结果
  - `extra` object — 拓展信息
  - `mcc_valid_result` object[] — 平台治理规则校验结果
    - `message` string — 消息内容
    - `type` integer — 消息类型(1:预警;2:拦截)
  - `pre_valid_result` object[] — 校验结果描述
    - `form` string — 拦截原因所属字段
    - `form_name` string — 拦截原因所属字段
    - `messages` string[] — 校验不通过原因
    - `module` string — 拦截原因所属的模块
    - `other_language_message_map` object — 其他语种弹窗错误信息列表（每个其他语种都有哪些错误信息）
      - `*` string[] — 
    - `skc_error_message_map` object — 
      - `*` object — 
  - `skc_list` object[] — SKC信息
    - `skc_name` string — SKC名称
    - `sku_list` object[] — SKU信息
      - `sku_code` string — SKU编码
      - `supplier_sku` string — 商家SKU
  - `spu_name` string — 编辑成功后返回的SPU Name
  - `success` boolean — 校验结果
  - `version` string — 审核版本号。 对应查询审核状态接口中的入参version。
- `msg` string — 错误描述,成功：OK

**Request example**


**Response example**



## Webhooks — product review results (Phase 2 follow-up, routed in `api/shein/webhook.js`)

Signed + AES-encrypted like every SHEIN push (`sheinOpenWebhook`); the event code arrives in `x-lt-eventcode`. Subscribe both in SHEIN's console (a user step). `product_document_audit_status_notice` does NOT fire for Seller Center publishes; `_all_channels` (doc 3001449) does, and has no `failed_reason`.

## POST `/product_document_audit_status_notice` — 商品审核通知
Doc id 3001450 · updated 2025-11-10 21:04:45 · QPS 

该消息用于通知 ERP 店铺商品的审核结果，包括商品信息的标题、描述、图片等更新通知。另外，请注意：该 webhook 不会通知商品价格和库存的变更，以及通过商家后台发布的商品审核结果 消息接入方式可查看文档：webhook说明文档

**Request body**
- `spu_name` string — 平台生成的SPU；对应发布接口的spu_name
- `skc_name` string — 平台生成的SKC；对应发布接口的skc_name
- `sku_list` object[] — 平台的SKU信息
  - `sku_code` string — 平台生成的SKU；对应发布接口的sku_code
- `document_sn` string — 商品审核的公文号
- `version` string — 调用发品接口时返回的版本号
- `audit_time` string — 商品审核时间
- `audit_state` integer — 审核状态(1:待审核;2:审批成功;3:审批失败;4:已撤回)
- `failed_reason` object[] **required** — 审核失败原因
  - `language` string — 语种
  - `content` string — 审核失败的原因描述

**Response body**

**Request example**
<pre><code >{ "spu_name": "h23121539315", "skc_name": "sh2312153931579766", "sku_list": [{ "sku_code": "I81ynllyzffh" }], "document_sn": "SPMPA420231215003106", "version": "SPMP231215009184753", "audit_time": "2023-12-18 11:46:43", "audit_state": 2, "failed_reason": null }</code></pre><p><br></p>

**Response example**



## POST `/product_document_receive_status_notice` — 商品接收通知
Doc id 3000910 · updated 2025-02-12 11:54:44 · QPS 

该消息用于通知 ERP SHEIN平台是否正常接收开发者的发品请求，消息接入方式可查看文档：webhook说明文档

**Request body**
- `spu_name` string — 平台生成的SPU；对应发布接口的spu_name
- `version` string — 调用发品接口时返回的版本号
- `received_success` boolean — SHEIN平台是否接收成功
- `document_details` object[] **required** — SHEIN平台接收的商品明细
  - `document_sn` string — 商品审核的公文号
  - `skc_name` string — 平台生成的SKC；对应发布接口的skc_name
  - `sku_list` object[] — SKU信息
    - `seller_sku` string — 商家的SKU，对应发布接口的supplier_sku
    - `sku_code` string — 平台生成的SKU；对应发布接口的sku_code
- `failed_reason` object[] **required** — 平台接收失败原因
  - `language` string — 语种
  - `content` string — 失败的原因描述

**Response body**

**Request example**
<p><br></p><pre><code >{ "spu_name": "s23121872106", "version": "SPMP231218173254739", "received_success": true, "document_details": [ { "document_sn": "SPMPA320231218041879", "skc_name": "ss2312187210636233", "sku_list": [ { "sku_code": "I41y8oidji5y", "seller_sku": "ieu8o1231123y" } ] } ], "failed_reason": null }</code></pre><p><br></p>

**Response example**



## Webhook — the price-rise review (Phase 3, routed in `api/shein/webhook.js` → `listingPriceAuditEvent`)

Pulled 2026-10-27. No query API exists for this review; we also poll spu-info for the new original price. Subscribe it in SHEIN's console (a user step).

## POST `/product_price_audit_status_notice` — 商品涨价审批结果通知
Doc id 3000912 · updated 2025-02-12 11:55:58 · QPS 

该消息用于通知 ERP 商品的涨价结果，消息接入方式可查看文档：webhook说明文档

**Request body**
- `spu_name` string — 平台生成的SPU；对应发布接口的spu_name
- `skc_name` string — 平台生成的SKC；对应发布接口的skc_name
- `sku_code` string — 平台生成的SKU；对应发布接口的sku_code
- `audit_state` integer — 审核状态（1:通过;2:驳回）
- `site` string — 商品销售站点
- `currency` string — 商品币种
- `audit_time` datetime — 商品审核时间
- `audit_reason` string — 商品审核失败的原因。审核通过时不返回数据

**Response body**

**Request example**
<pre><code >{ "spu_name": "", "skc_name": "", "sku_code": "", "audit_state": 2, "site": "shein-br", "currency": "BRL", "audit_time": "2024-02-01 15:00:00", "audit_reason": "Review Failed: Your Sale Price does not meet the qualifications to be recommended by the platform" }</code></pre><p><br></p>

**Response example**

