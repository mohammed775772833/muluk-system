const express = require('express');
const pool = require('../../db');
const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();

// GET /api/customers
router.get(
    '/',
    authenticateToken,
    requirePermission('CUSTOMERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    customer_id,
                    customer_no,
                    full_name,
                    phone,
                    alternate_phone,
                    email,
                    address,
                    notes,
                    created_at,
                    updated_at
                FROM customers
                ORDER BY customer_id DESC
            `);

            res.json({
                success: true,
                count: result.rows.length,
                customers: result.rows
            });

        } catch (error) {
            console.error('Get customers error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch customers'
            });
        }
    }
);

// GET /api/customers/:id
router.get(
    '/:id',
    authenticateToken,
    requirePermission('CUSTOMERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    customer_id,
                    customer_no,
                    full_name,
                    phone,
                    alternate_phone,
                    email,
                    address,
                    notes,
                    created_at,
                    updated_at
                FROM customers
                WHERE customer_id = $1
            `, [req.params.id]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Customer not found'
                });
            }

            res.json({
                success: true,
                customer: result.rows[0]
            });

        } catch (error) {
            console.error('Get customer error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch customer'
            });
        }
    }
);

// POST /api/customers
router.post(
    '/',
    authenticateToken,
    requirePermission('CUSTOMERS_MANAGE'),
    async (req, res) => {
        try {
            const {
                full_name,
                phone,
                alternate_phone,
                email,
                address,
                notes
            } = req.body;

            if (!full_name || !phone) {
                return res.status(400).json({
                    success: false,
                    message: 'Full name and phone are required'
                });
            }

            const result = await pool.query(`
                INSERT INTO customers (
                    full_name,
                    phone,
                    alternate_phone,
                    email,
                    address,
                    notes
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                RETURNING
                    customer_id,
                    customer_no,
                    full_name,
                    phone,
                    alternate_phone,
                    email,
                    address,
                    notes,
                    created_at,
                    updated_at
            `, [
                full_name,
                phone,
                alternate_phone || null,
                email || null,
                address || null,
                notes || null
            ]);

            res.status(201).json({
                success: true,
                message: 'Customer created successfully',
                customer: result.rows[0]
            });

        } catch (error) {
            console.error('Create customer error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to create customer'
            });
        }
    }
);

module.exports = router;
