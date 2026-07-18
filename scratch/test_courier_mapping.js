require('dotenv').config({ path: 'c:/Users/kiaan/Desktop/Kiaan/WMS New Software/WMS-backend/.env' });
const { sequelize, CourierMapping, SalesOrder, Product, User, ProductStock, OrderItem, InventoryLog } = require('../models');
const { Op } = require('sequelize');
const orderService = require('../services/orderService');
const inventoryService = require('../services/inventoryService');

async function run() {
  const t = await sequelize.transaction();
  try {
    console.log('Running integration tests for Courier Mapping...');

    // 1. Get default company admin user
    const user = await User.findOne({ where: { role: 'company_admin' }, transaction: t });
    if (!user) throw new Error('Company admin user not found');
    const companyId = user.companyId;

    // 2. Create a courier mapping rule
    console.log('Creating test mapping rule: "Standard Shipping" -> Royal Mail (Tracked 48)...');
    const mapping = await CourierMapping.create({
      companyId,
      requestedService: 'Standard Shipping',
      courierName: 'Royal Mail',
      courierService: 'Royal Mail Tracked 48'
    }, { transaction: t });

    // 3. Find a product with available stock
    const stockRow = await ProductStock.findOne({
      where: {
        companyId,
        quantity: { [Op.gt]: sequelize.col('reserved') }
      },
      include: [{ model: Product, required: true }],
      transaction: t
    });

    if (!stockRow || !stockRow.Product) {
      throw new Error('No product with available stock found for testing');
    }
    const product = stockRow.Product;
    console.log(`Using product SKU "${product.sku}" (Available Qty: ${stockRow.quantity - stockRow.reserved})`);

    // 4. Test Manual Creation Resolution
    console.log('Testing manual order creation mapping...');
    const manualOrderPayload = {
      requestedShippingService: 'Standard Shipping',
      recipientName: 'Test Recipient',
      addressLine1: '123 Test St',
      town: 'Test City',
      postcode: 'TS1 1ST',
      country: 'UNITED KINGDOM',
      items: [
        {
          productId: product.id,
          quantity: 1,
          unitPrice: 10.00
        }
      ]
    };

    await t.commit();
    console.log('Mapping rule committed for testing.');

    // Test manual creation
    const createdOrder = await orderService.create(manualOrderPayload, user);
    console.log(`Created Order ID: ${createdOrder.id}`);
    console.log(`Requested: "${createdOrder.requestedShippingService}"`);
    console.log(`Mapped Courier: "${createdOrder.courierName}"`);
    console.log(`Mapped Service: "${createdOrder.courierService}"`);

    if (createdOrder.courierName !== 'Royal Mail' || createdOrder.courierService !== 'Royal Mail Tracked 48') {
      throw new Error('Manual order courier mapping failed!');
    }
    console.log('✔ Manual order courier mapping resolution passed.');

    // 5. Test CSV Import Resolution
    console.log('Testing CSV order import mapping...');
    const csvRows = [
      {
        'Order Number': `TEST-CSV-${Date.now()}`,
        'Recipient Name': 'CSV Recipient',
        'Address Line 1': '456 CSV Road',
        'Town': 'CSV Town',
        'Postcode': 'CS1 1CS',
        'Country': 'UNITED KINGDOM',
        'SKU': product.sku,
        'Quantity': '1',
        'Unit Price': '12.50',
        'Requested Shipping Service': 'Standard Shipping'
      }
    ];

    const importRes = await orderService.importCsv(csvRows, user);
    console.log(`Import completed.`);

    // Retrieve the imported order
    const importedOrder = await SalesOrder.findOne({
      where: { orderNumber: csvRows[0]['Order Number'] }
    });
    if (!importedOrder) throw new Error('Imported order record not found');

    console.log(`Imported Order Number: ${importedOrder.orderNumber}`);
    console.log(`Requested: "${importedOrder.requestedShippingService}"`);
    console.log(`Mapped Courier: "${importedOrder.courierName}"`);
    console.log(`Mapped Service: "${importedOrder.courierService}"`);

    if (importedOrder.courierName !== 'Royal Mail' || importedOrder.courierService !== 'Royal Mail Tracked 48') {
      throw new Error('CSV import courier mapping failed!');
    }
    console.log('✔ CSV import courier mapping resolution passed.');

    // Cleanup test data
    console.log('Cleaning up test data...');
    
    // Release the soft reserves on the warehouse level
    const ut1 = await sequelize.transaction();
    try {
      await inventoryService.unreserveStockSoft({
        productId: product.id,
        warehouseId: stockRow.warehouseId,
        quantity: 1,
        referenceId: createdOrder.orderNumber,
        reason: 'Test Cleanup',
        userId: user.id
      }, ut1);
      
      await inventoryService.unreserveStockSoft({
        productId: product.id,
        warehouseId: stockRow.warehouseId,
        quantity: 1,
        referenceId: importedOrder.orderNumber,
        reason: 'Test Cleanup',
        userId: user.id
      }, ut1);
      
      await ut1.commit();
      console.log('Soft stock unreserved.');
    } catch (e) {
      await ut1.rollback();
      console.error('Failed to unreserve soft stock during cleanup:', e.message);
    }

    // Delete the order items & orders
    await OrderItem.destroy({ where: { salesOrderId: [createdOrder.id, importedOrder.id] } });
    await SalesOrder.destroy({ where: { id: [createdOrder.id, importedOrder.id] } });
    await CourierMapping.destroy({ where: { id: mapping.id } });
    
    // Delete the inventory logs created during the test
    await InventoryLog.destroy({
      where: {
        productId: product.id,
        referenceId: { [Op.in]: [createdOrder.orderNumber, importedOrder.orderNumber, 'Test Cleanup'] }
      }
    });

    console.log('Test records deleted.');
    console.log('ALL TESTS PASSED SUCCESSFULLY!');

  } catch (err) {
    console.error('Test run failed:', err.message);
    if (!t.finished) {
      await t.rollback();
    }
  } finally {
    await sequelize.close();
  }
}

run();
