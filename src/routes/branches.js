const express = require('express');
const router = express.Router();

const pool = require('../../db');
const { authenticateToken, requirePermission } = require('../middleware/auth');

router.get('/', authenticateToken, requirePermission('INVENTORY_VIEW'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                branch_id,
                branch_code,
                branch_name,
                address,
                phone,
                status
            FROM branches
            WHERE status = 'ACTIVE'
            ORDER BY branch_name
        `);

        res.json({
            success: true,
            count: result.rows.length,
            branches: result.rows
        });

    } catch (error) {
        console.error('Get branches error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to get branches'
        });
    }
});



// GET one branch
router.get('/:id', authenticateToken, requirePermission('INVENTORY_VIEW'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT
        branch_id,
        branch_code,
        branch_name,
        address,
        phone,
        manager_id,
        status,
        created_at,
        updated_at
      FROM branches
      WHERE branch_id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    res.json({
      success: true,
      branch: result.rows[0]
    });

  } catch (error) {
    console.error('Get branch error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to get branch'
    });
  }
});

// CREATE branch
router.post('/', authenticateToken, requirePermission('INVENTORY_MANAGE'), async (req, res) => {
  try {
    const {
      branch_code,
      branch_name,
      address,
      phone,
      status
    } = req.body;

    if (!branch_code || !branch_name) {
      return res.status(400).json({
        success: false,
        message: 'branch_code and branch_name are required'
      });
    }

    const result = await pool.query(`
      INSERT INTO branches
        (branch_code, branch_name, address, phone, status)
      VALUES
        ($1, $2, $3, $4, COALESCE($5, 'ACTIVE')::branch_status)
      RETURNING
        branch_id,
        branch_code,
        branch_name,
        address,
        phone,
        status,
        created_at,
        updated_at
    `, [
      branch_code.trim(),
      branch_name.trim(),
      address || null,
      phone || null,
      status || 'ACTIVE'
    ]);

    res.status(201).json({
      success: true,
      message: 'Branch created successfully',
      branch: result.rows[0]
    });

  } catch (error) {
    console.error('Create branch error:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Branch code already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create branch'
    });
  }
});


// UPDATE branch
router.patch('/:id', authenticateToken, requirePermission('INVENTORY_MANAGE'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      branch_code,
      branch_name,
      address,
      phone,
      status
    } = req.body;

    if (!branch_code || !branch_name) {
      return res.status(400).json({
        success: false,
        message: 'branch_code and branch_name are required'
      });
    }

    const result = await pool.query(`
      UPDATE branches
      SET
        branch_code = $1,
        branch_name = $2,
        address = $3,
        phone = $4,
        status = $5::branch_status
      WHERE branch_id = $6
      RETURNING
        branch_id,
        branch_code,
        branch_name,
        address,
        phone,
        status,
        created_at,
        updated_at
    `, [
      branch_code.trim(),
      branch_name.trim(),
      address || null,
      phone || null,
      status || 'ACTIVE',
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    res.json({
      success: true,
      message: 'Branch updated successfully',
      branch: result.rows[0]
    });

  } catch (error) {
    console.error('Update branch error:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Branch code already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update branch'
    });
  }
});

module.exports = router;
