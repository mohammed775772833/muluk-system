const express = require('express');
const router = express.Router();

const pool = require('../../db');
const { authenticateToken, requirePermission } = require('../middleware/auth');

// GET /api/inventory/balances
// عرض المخزون الحالي لكل المواد والفروع
router.get('/balances', authenticateToken, requirePermission('INVENTORY_VIEW'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                ib.inventory_balance_id,
                ib.branch_id,
                b.branch_name,
                ib.material_id,
                m.material_code,
                m.material_name,
                m.category,
                m.unit,
                m.minimum_stock,
                m.standard_cost,
                ib.quantity_on_hand,
                ib.updated_at,
                CASE
                    WHEN ib.quantity_on_hand <= m.minimum_stock THEN true
                    ELSE false
                END AS low_stock
             FROM inventory_balances ib
             JOIN branches b ON b.branch_id = ib.branch_id
             JOIN materials m ON m.material_id = ib.material_id
             WHERE m.is_active = true
             ORDER BY b.branch_id, m.material_name`
        );

        res.json({
            success: true,
            count: result.rows.length,
            balances: result.rows
        });
    } catch (error) {
        console.error('Get inventory balances error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to get inventory balances'
        });
    }
});

// POST /api/inventory/receipts
// استلام مادة إلى مخزون الفرع
router.post('/receipts', authenticateToken, requirePermission('INVENTORY_MANAGE'), async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            branch_id,
            material_id,
            quantity,
            unit_cost,
            reference_no,
            notes
        } = req.body;

        if (!branch_id) {
            return res.status(400).json({
                success: false,
                message: 'branch_id is required'
            });
        }

        if (!material_id) {
            return res.status(400).json({
                success: false,
                message: 'material_id is required'
            });
        }

        const finalQuantity = Number(quantity);

        if (!Number.isFinite(finalQuantity) || finalQuantity <= 0) {
            return res.status(400).json({
                success: false,
                message: 'quantity must be greater than 0'
            });
        }

        await client.query('BEGIN');

        const branch = await client.query(
            `SELECT branch_id, branch_code, branch_name, status
             FROM branches
             WHERE branch_id = $1
             FOR UPDATE`,
            [branch_id]
        );

        if (branch.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Branch not found'
            });
        }

        if (branch.rows[0].status !== 'ACTIVE') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Branch is not active'
            });
        }

        const material = await client.query(
            `SELECT material_id, material_code, material_name,
                    category, unit, standard_cost, is_active
             FROM materials
             WHERE material_id = $1
             FOR UPDATE`,
            [material_id]
        );

        if (material.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Material not found'
            });
        }

        if (!material.rows[0].is_active) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Material is inactive'
            });
        }

        const finalUnitCost =
            unit_cost !== undefined && unit_cost !== null
                ? Number(unit_cost)
                : Number(material.rows[0].standard_cost);

        if (!Number.isFinite(finalUnitCost) || finalUnitCost < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'unit_cost must be 0 or greater'
            });
        }

        const transactionResult = await client.query(
            `INSERT INTO inventory_transactions
                (branch_id, material_id, transaction_type,
                 quantity, unit_cost, reference_no, notes, created_by)
             VALUES ($1, $2, 'RECEIPT', $3, $4, $5, $6, $7)
             RETURNING transaction_id, transaction_no, branch_id,
                       material_id, transaction_type, quantity,
                       unit_cost, reference_no, notes, created_by, created_at`,
            [
                branch_id,
                material_id,
                finalQuantity,
                finalUnitCost,
                reference_no || null,
                notes || null,
                req.user.user_id
            ]
        );

        const balance = await client.query(
            `INSERT INTO inventory_balances
                (branch_id, material_id, quantity_on_hand, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (branch_id, material_id)
             DO UPDATE SET
                 quantity_on_hand = inventory_balances.quantity_on_hand + EXCLUDED.quantity_on_hand,
                 updated_at = CURRENT_TIMESTAMP
             RETURNING inventory_balance_id, branch_id,
                       material_id, quantity_on_hand, updated_at`,
            [branch_id, material_id, finalQuantity]
        );

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Material received and inventory updated successfully',
            transaction: transactionResult.rows[0],
            material: {
                material_id: material.rows[0].material_id,
                material_code: material.rows[0].material_code,
                material_name: material.rows[0].material_name,
                category: material.rows[0].category,
                unit: material.rows[0].unit
            },
            branch: {
                branch_id: branch.rows[0].branch_id,
                branch_code: branch.rows[0].branch_code,
                branch_name: branch.rows[0].branch_name
            },
            inventory: {
                transaction_type: 'RECEIPT',
                quantity_received: finalQuantity,
                quantity_on_hand: balance.rows[0].quantity_on_hand
            }
        });
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Inventory receipt rollback error:', rollbackError);
        }

        console.error('Receive material / inventory error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to receive material and update inventory'
        });
    } finally {
        client.release();
    }
});

module.exports = router;
