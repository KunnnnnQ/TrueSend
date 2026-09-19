// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain ERC-20 used as the stand-in for USDC/USDT in tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Refuses incoming ETH, so the native-transfer failure path can be exercised.
contract RejectingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}

/// @notice Tries to call back into the policy while receiving ETH.
/// @dev Used to prove the transient reentrancy guard actually holds.
contract ReenteringReceiver {
    address public target;
    bytes public payload;
    bool public attempted;
    bool public succeeded;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    receive() external payable {
        if (target == address(0) || attempted) return;
        attempted = true;
        (bool ok,) = target.call(payload);
        succeeded = ok;
    }
}
